import makeWASocket, {
  areJidsSameUser,
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys'
import * as fs from 'fs'
import * as path from 'path'
import pino, { Logger } from 'pino'

export interface InboundMessage {
  from: string
  /**
   * The same contact's other address, when WhatsApp supplies one — the phone JID for a
   * LID-migrated contact, since `from` is then `<id>@lid`.
   *
   * Load-bearing rather than diagnostic: an operator blacklists or whitelists a phone number,
   * because nobody knows their own contacts' LIDs, and without this the rule is stored against
   * an address no inbound message ever arrives under. Empty means WhatsApp told us nothing —
   * which is *unknown*, never "this contact has no number".
   */
  fromAlt?: string
  text: string
  messageId: string
  /** Id of the message this one quotes, when the user replied to something. */
  quotedMessageId?: string
  /** Text of the quoted message, so the agent can see what is being replied to. */
  quotedText?: string
  /** True when `from` is a group rather than an individual chat. */
  isGroup?: boolean
  /** Group subject, when known. Empty until the metadata lookup has warmed. */
  groupName?: string
  /** The individual who actually sent this, which in a group is not `from`. */
  senderJid?: string
  /** That individual's WhatsApp display name. */
  senderName?: string
  /**
   * Whether this message addresses the bot — resolved here rather than upstream because
   * only the connector knows the bot's own JID and LID.
   */
  isAddressedToBot?: boolean
  /**
   * Whether the message @mentions somebody who is not the bot. The cheapest possible "this is
   * not for us": an @ of another member is a message aimed at that member.
   */
  mentionsOthers?: boolean
  /**
   * When this message quotes another, whether the quoted message was the bot's own. A reply to
   * the bot is addressed to it; a reply to another member is addressed to that member. False
   * when nothing is quoted.
   */
  quotedFromAgent?: boolean
  /**
   * True when this arrived as a voice note. `text` is then the transcript, resolved upstream
   * before the message was submitted — everything downstream reads an ordinary text message.
   */
  isVoiceNote?: boolean
  /** How long the voice note was, as WhatsApp reported it. Diagnostic only. */
  voiceSeconds?: number
  /**
   * Hosted URLs of the pictures this message carried, empty for a message with none.
   *
   * The pictures never travel over the hub. Each one is uploaded before the message is submitted
   * and only the URL is forwarded — the same arrangement a voice note has, where the transcript
   * travels and the audio does not.
   *
   * The one thing this changes for callers is that `text` may be empty on a message that still
   * deserves an answer: WhatsApp lets somebody send a picture with no caption, and such a message
   * used to be dropped right here in the connector.
   */
  imageUrls?: string[]
  /**
   * MIME type of an attachment nobody upstream can show the agent, empty when there is none.
   *
   * Set for a video, for a document, and for a picture whose upload was refused — anything, in
   * other words, that arrived with a caption the agent is about to be handed on its own. Upstream
   * names it in the turn so the agent can answer the words and admit it could not see the file,
   * rather than confidently answering about a document that never reached it.
   *
   * Empty when the message carried a picture the agent *can* see: that one is in `imageUrls`.
   */
  unreadableAttachment?: string
  /**
   * The files this message carried, hosted where the agent can read them.
   *
   * Only the types the platform can turn into text reach here (PDF, TXT, MD); anything else is an
   * attachment nobody can read, which is what `unreadableAttachment` is for. Same arrangement as
   * `imageUrls`: uploaded before the message is submitted, and only the URL travels.
   */
  documents?: InboundDocument[]
}

/**
 * A file the sender attached, once it has somewhere to live.
 */
export interface InboundDocument {
  url: string
  /** The name it had on the sender's device, which is what the agent will refer to. */
  fileName: string
}

/**
 * What the upload endpoint needs to know about the message a picture arrived with, so it can
 * refuse the ones that provably cannot matter — a captionless picture in a room that did not
 * address the agent will never be answered or recorded, so hosting it buys nothing.
 *
 * Passed as an object rather than four more parameters because it is one fact — the shape of the
 * message — read by one caller.
 */
export interface InboundImageContext {
  /** The chat the picture arrived in: a group JID for groups, the sender otherwise. */
  from: string
  isGroup: boolean
  /** Whether the message addresses the agent. Always true in an individual chat. */
  isAddressedToBot: boolean
  /** Whether the picture came with a caption. */
  hasText: boolean
}

/**
 * A user reacting to a message with an emoji.
 *
 * Reactions arrive on their own Baileys event, not as messages — they have no text, so the
 * inbound message path drops them. Everything needed to decide whether the reaction deserves
 * an answer is resolved here, for the same reason as `InboundMessage.isAddressedToBot`: only
 * the connector knows the bot's own JID and LID.
 */
export interface InboundReaction {
  /** The chat the reaction happened in — a group JID for groups, the user otherwise. */
  from: string
  /**
   * The same contact's phone JID when `from` is a LID, exactly as `InboundMessage.fromAlt`.
   *
   * Carried for one reason: upstream keys a contact by their number, and a reaction that
   * arrived without one would be filed under the LID instead — splitting one person into two
   * the moment they answer with an emoji rather than words.
   */
  fromAlt?: string
  /** The emoji. Empty when the user REMOVED their reaction. */
  emoji: string
  /** Id of the message being reacted to. */
  targetMessageId: string
  /**
   * Whether the reacted-to message was sent by the bot, per WhatsApp's own key.
   *
   * Deliberately reported rather than trusted: upstream cross-checks it against its own
   * record of what it sent, because a reaction to a message the bot never sent must never
   * trigger an answer.
   */
  targetFromMe: boolean
  /** Text of the reacted-to message when the connector still holds it. Often empty. */
  targetText?: string
  /** Who reacted. In a group this is the individual, not the group. */
  reactorJid: string
  /** That individual's WhatsApp display name, when known. */
  reactorName?: string
  /** True when `from` is a group rather than an individual chat. */
  isGroup?: boolean
  /** Group subject, when known. */
  groupName?: string
  /** True when the reaction came from the bot's own number — upstream must ignore these. */
  isFromSelf?: boolean
}

export interface WaCallbacks {
  onQr: (qrBase64: string) => void
  onConnected: (phoneNumber: string) => void
  onDisconnected: (reason: string, shouldReconnect: boolean) => void
  onMessage: (msg: InboundMessage) => void
  onReaction: (reaction: InboundReaction) => void
  /**
   * Turns a downloaded voice note into words, by asking Messenger-BE.
   *
   * Lives on the callback rather than in here because only the owning session knows how to reach
   * Messenger-BE, and because the answer is not the connector's to decide: the reply says whether
   * the channel is even set up to pay for transcription. Returning null means "no words" — for any
   * reason, including a deliberate refusal — and the message is then dropped, exactly as an
   * untranscribed voice note is dropped today.
   *
   * Optional so a session that has no interest in audio (or a test harness) can omit it, in which
   * case voice notes are ignored as they always were.
   */
  transcribeVoiceNote?: (
    audio: Buffer,
    mimeType: string,
    seconds: number,
    messageId: string,
  ) => Promise<string | null>
  /**
   * Puts a downloaded picture somewhere the agent can look at it, by asking Messenger-BE, and
   * returns the URL.
   *
   * On the callback for the same reasons `transcribeVoiceNote` is: only the owning session knows
   * how to reach Messenger-BE, and the answer is not the connector's to decide — the reply says
   * whether this channel is set up to pay for the picture at all.
   *
   * Null means "no picture the agent can see", for any reason including a deliberate refusal. The
   * caller then submits the message without it, which leaves a captioned picture answered on its
   * caption and a captionless one dropped: exactly the behaviour this channel had before.
   *
   * Optional, so a session with no interest in media (or a test harness) can omit it and pictures
   * are ignored as they always were.
   */
  hostImage?: (
    image: Buffer,
    mimeType: string,
    messageId: string,
    context: InboundImageContext,
  ) => Promise<string | null>
  /**
   * The same for a document, and separate from `hostImage` because the two are refused for
   * different reasons and end up as different things: a picture the model looks at, a file whose
   * text is extracted before any model sees it.
   */
  hostDocument?: (
    document: Buffer,
    mimeType: string,
    fileName: string,
    messageId: string,
    context: InboundImageContext,
  ) => Promise<string | null>
}

/**
 * One WhatsApp (Baileys) session, fully instance-scoped — its own socket, its
 * own on-disk auth state, its own message cache. This is the multi-session
 * equivalent of the single-session `whatsapp.ts` used by the GUI connector; the
 * server mode holds many of these at once (one per tenant).
 */
export class WaSession {
  private socket: WASocket | null = null
  private phoneNumber: string | null = null
  private readonly waDir: string
  private readonly messageStore = new Map<string, proto.IMessage>()
  // Full inbound messages kept so a later reply can quote them. Baileys needs the whole
  // WAMessage (key + content) to build the quote, not just the content that `messageStore`
  // holds for retry/decryption.
  private readonly quotableStore = new Map<string, WAMessage>()
  // Group subjects, warmed in the background. A miss just means the first message from a
  // group carries no name — never worth blocking message delivery on a metadata round-trip.
  private readonly groupSubjects = new Map<string, string>()
  /*
    Display names, learned as people speak.

    WhatsApp does not put names in a message's text. When somebody types "@Mega Syintia" what
    travels is "@270875081363521" — the name you see is rendered by your own client from the
    `mentionedJid` list. So an assistant reading the raw text sees a phone-number-shaped id, and
    duly repeats it back, which is how it ended up writing "Halo mba Syintia (@270875081363521)".

    `pushName` is the one reliable source, and it arrives with each message its owner sends. Group
    metadata sometimes carries names too, but for privacy-migrated (LID) rooms those are usually
    blank unless the person is in your address book — so metadata seeds this map, and speech fills
    it in.

    Keyed on the digits of a jid rather than the whole thing, because the same person reaches us
    as `…@s.whatsapp.net` in one place and `…@lid` in another, and a mention in text carries only
    the digits.
  */
  private readonly displayNames = new Map<string, string>()
  // The full jid each person was last seen under, keyed the same way. A mention has to go back out
  // in the domain the room actually uses — a lid room will not resolve an @s.whatsapp.net jid.
  private readonly knownJids = new Map<string, string>()
  private readonly log: Logger
  private readonly baileysLogger: Logger

  /**
   * The number this session is currently linked to, or null when the socket is not open.
   * Lets the owner re-report the link to Messenger-BE without waiting for Baileys to fire
   * `connection.update` again — which it won't, if the WhatsApp socket never dropped.
   */
  get connectedPhoneNumber(): string | null {
    return this.phoneNumber
  }

  constructor(sessionDir: string, label: string) {
    this.waDir = path.join(sessionDir, 'wa_session')
    this.log = pino({ level: process.env.WA_LOG_LEVEL ?? 'info' }).child({ session: label })
    this.baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'silent' })
  }

  private cache(id: string | null | undefined, message: proto.IMessage | null | undefined): void {
    if (!id || !message) return
    if (this.messageStore.size > 2000) {
      const oldest = this.messageStore.keys().next().value
      if (oldest !== undefined) this.messageStore.delete(oldest)
    }
    this.messageStore.set(id, message)
  }

  /**
   * Returns the cached group subject, kicking off a lookup when it is not known yet.
   *
   * Deliberately non-blocking: awaiting `groupMetadata` inside the message handler would let
   * later messages overtake earlier ones. The first message from a group therefore carries an
   * empty name and every one after it is named.
   */
  /**
   * Returns the cached group subject, kicking off a lookup when it is not known yet.
   * Deliberately non-blocking so later messages cannot overtake earlier ones.
   *
   * A failed or empty lookup **forgets the key** rather than caching the empty string. Reserving
   * the key and leaving it reserved is what made some groups permanently nameless: the reservation
   * reads as a cached answer, so a lookup that failed once — a socket mid-reconnect, a rate-limited
   * metadata call — was never retried for the life of the process.
   */
  private groupSubject(jid: string): string {
    const cached = this.groupSubjects.get(jid)

    if (cached) return cached

    // No socket, no lookup — and no reservation either, or the next message would read the
    // reservation as a cached answer and never try again.
    if (!this.socket) return ''

    // A reservation only while a lookup is genuinely in flight.
    if (cached === '') return ''

    this.groupSubjects.set(jid, '')

    void this.socket
      .groupMetadata(jid)
      .then((meta) => {
        // Free ride on a lookup already happening. Participants give us every member's jid whether
        // they have ever spoken or not, which is what makes it possible to @mention somebody who
        // has said nothing — and a saved contact was never required for that, only the jid.
        this.rememberParticipants(meta?.participants)

        const subject = meta?.subject ?? ''

        if (subject) {
          this.groupSubjects.set(jid, subject)
          this.log.info({ jid, subject }, '[wa] group subject resolved')
          return
        }

        // Resolved to nothing. Forgotten rather than cached, so a group renamed after a blank
        // answer eventually gets its name.
        this.groupSubjects.delete(jid)
      })
      .catch((err) => {
        // Dropped so the next message retries. This is the line that was missing.
        this.groupSubjects.delete(jid)
        this.log.warn(
          { err, jid },
          '[wa] group metadata lookup failed — will retry on the next message',
        )
      })

    return ''
  }

  /**
   * Whether a group message actually addresses the bot.
   *
   * Two ways count, because both are how people really summon a bot in a group:
   *   1. an @mention of the bot;
   *   2. a reply to one of the bot's own messages.
   *
   * The bot has two identities — its phone JID and its LID — and a mention may arrive as
   * either, so both are compared. Matching only the phone number would leave the bot deaf in
   * every LID-migrated group.
   */
  /**
   * Records every member of a group, so a mention does not depend on having heard them speak.
   *
   * Names are taken only when WhatsApp actually supplies one — `notify`/`name` are usually blank
   * in a LID room unless the person is in your address book, and a blank is left blank rather than
   * filled with the id. The jid is the part that matters: with it, "@<id>" in an outgoing message
   * becomes a real mention even for somebody with no name at all.
   */
  private rememberParticipants(
    participants: { id?: string | null; name?: string | null; notify?: string | null }[] | null | undefined,
  ): void {
    if (!participants) return

    for (const p of participants) {
      const digits = WaSession.jidDigits(p?.id ?? '')
      if (!digits) continue

      // Never downgrade a name learned from speech, which is the more current of the two.
      if (!this.knownJids.has(digits)) this.knownJids.set(digits, p.id!)

      const supplied = (p.notify ?? p.name ?? '').trim()
      if (supplied && !this.displayNames.has(digits)) this.displayNames.set(digits, supplied)
    }
  }

  /** Records somebody's display name against the digits of their jid. */
  private rememberName(jid: string | null | undefined, pushName: string | null | undefined): void {
    if (!jid || !pushName) return

    const digits = WaSession.jidDigits(jid)
    if (!digits) return

    // Latest wins. People rename themselves, and the newest thing they answered to is the name
    // the room will recognise.
    this.displayNames.set(digits, pushName.trim())
    this.knownJids.set(digits, jid)
  }

  /** The numeric part of a jid — the form a mention takes inside message text. */
  private static jidDigits(jid: string): string {
    return jid.split('@')[0]?.split(':')[0] ?? ''
  }

  /**
   * Rewrites "@<id>" in inbound text to "@<display name>".
   *
   * Driven by `mentionedJid` rather than by scanning for digit runs, so an ordinary number in a
   * sentence — a price, a year, a phone number somebody typed out — is never mistaken for a
   * mention. An id we have no name for is left exactly as it arrived.
   */
  private namesForIds(text: string, contextInfo: proto.IContextInfo | null | undefined): string {
    const mentioned = contextInfo?.mentionedJid ?? []
    if (mentioned.length === 0) return text

    let out = text

    for (const jid of mentioned) {
      const digits = WaSession.jidDigits(jid ?? '')
      if (!digits) continue

      const name = this.displayNames.get(digits)
      if (!name) continue

      out = out.split(`@${digits}`).join(`@${name}`)
    }

    return out
  }

  /**
   * Turns "@<display name>" in an outgoing message back into a real WhatsApp mention.
   *
   * Longest name first, so "@Mega Syintia" is not half-matched by a "@Mega" who also exists. A
   * name we cannot resolve is left as plain text: the worst outcome is a mention that does not
   * light up, never a mention pointing at the wrong person.
   */
  private idsForNames(text: string): { text: string; mentions: string[] } {
    if (!text.includes('@')) return { text, mentions: [] }

    let out = text

    // Names first, longest wins, so "@Mega Syintia" is not half-matched by a "@Mega" who exists.
    const byLongestName = [...this.displayNames.entries()].sort(
      ([, a], [, b]) => b.length - a.length,
    )

    for (const [digits, name] of byLongestName) {
      if (!name) continue

      const needle = `@${name}`
      if (!out.includes(needle)) continue

      out = out.split(needle).join(`@${digits}`)
    }

    /*
      Then collect ids, which is the same scan for both routes.

      Names have just become ids above, and an id may also have been written directly — a member
      nobody has a name for, or one the agent copied out of the history. Both are the wire form a
      mention needs, so the two cases converge here rather than being handled twice.

      Only ids we recognise are claimed. An unknown one stays plain text: mentioning a jid that is
      not in the room does nothing useful and asks WhatsApp about a stranger.
    */
    const mentions = [
      ...new Set(
        [...out.matchAll(/@(\d{5,})/g)]
          .map((m) => m[1]!)
          .filter((digits) => this.knownJids.has(digits))
          .map((digits) => this.jidForDigits(digits)),
      ),
    ]

    return { text: out, mentions }
  }

  /**
   * Rebuilds a full jid from the digits we cached, preferring whichever domain we have actually
   * seen this person under.
   */
  private jidForDigits(digits: string): string {
    const seen = this.knownJids.get(digits)

    return seen ?? `${digits}@s.whatsapp.net`
  }

  private readAddressing(
    contextInfo: proto.IContextInfo | null | undefined,
  ): Pick<InboundMessage, 'isAddressedToBot' | 'mentionsOthers' | 'quotedFromAgent'> {
    const me = [this.socket?.user?.id, this.socket?.user?.lid].filter(Boolean) as string[]

    // No identity yet means no honest answer to any of the three. All false reads upstream as
    // "unknown", which costs a free negative and never invents one.
    if (me.length === 0) {
      return { isAddressedToBot: false, mentionsOthers: false, quotedFromAgent: false }
    }

    const isMe = (jid: string | null | undefined) =>
      !!jid && me.some((mine) => areJidsSameUser(jid, mine))

    const mentioned = contextInfo?.mentionedJid ?? []
    const mentionsBot = mentioned.some(isMe)
    const mentionsOthers = mentioned.some((jid) => !isMe(jid))

    // The *author* of the quoted message, so this is "did they reply to us" rather than
    // "did they reply at all".
    const quotedFromAgent = isMe(contextInfo?.participant)

    return { isAddressedToBot: mentionsBot || quotedFromAgent, mentionsOthers, quotedFromAgent }
  }

  /**
   * The text of a message, whichever content type happens to carry it.
   *
   * Every caption belongs here, including a video's and a document's. The inbound path used to read
   * only `conversation`, `extendedTextMessage` and an image's caption, which meant somebody who
   * wrote a sentence under a video was answered with silence — a duplicate of this list is how that
   * happened, so there is now one list and everything reads it.
   */
  private static textOf(message: proto.IMessage | null | undefined): string {
    if (!message) return ''

    return (
      message.conversation ??
      message.extendedTextMessage?.text ??
      message.imageMessage?.caption ??
      message.videoMessage?.caption ??
      message.documentMessage?.caption ??
      ''
    )
  }

  /**
   * The picture a message carries, if it carries one the agent could look at.
   *
   * A photo sent the ordinary way is an `imageMessage`. A photo sent with WhatsApp's "send as
   * document" — which people use precisely when the picture matters, because it skips the
   * re-encoding — is a `documentMessage` whose MIME type happens to be an image, and is just as
   * readable once downloaded.
   *
   * Stickers are deliberately not here. They are decoration with an image's shape: reading one
   * costs the same image tokens as a photograph and answers a question nobody asked.
   */
  private static imageOf(
    message: proto.IMessage | null | undefined,
  ): { mimeType: string; fileLength: number } | null {
    if (!message) return null

    const image = message.imageMessage

    if (image) {
      return { mimeType: image.mimetype ?? 'image/jpeg', fileLength: Number(image.fileLength ?? 0) }
    }

    const document = message.documentMessage
    const documentType = document?.mimetype ?? ''

    if (document && documentType.startsWith('image/')) {
      return { mimeType: documentType, fileLength: Number(document.fileLength ?? 0) }
    }

    return null
  }

  /**
   * The document a message carries, if it carries one the platform can turn into text.
   *
   * Decided on the file name's extension rather than the MIME type, because WhatsApp reports
   * whatever the sending device felt like — "application/octet-stream" for an ordinary PDF is
   * common — while the name is both more reliable and the thing the upload actually switches on.
   *
   * A document whose MIME type is an image is not here: that is a photo sent the "as document" way,
   * and `imageOf` has already claimed it.
   */
  private static documentOf(
    message: proto.IMessage | null | undefined,
  ): { mimeType: string; fileName: string; fileLength: number } | null {
    const document = message?.documentMessage

    if (!document) return null
    if ((document.mimetype ?? '').startsWith('image/')) return null

    const fileName = document.fileName ?? ''
    const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()

    if (extension !== '.pdf' && extension !== '.txt' && extension !== '.md') return null

    return {
      mimeType: document.mimetype ?? 'application/octet-stream',
      fileName,
      fileLength: Number(document.fileLength ?? 0),
    }
  }

  /**
   * The MIME type of whatever media a message carries, for naming an attachment nobody can read.
   *
   * Stickers are left out on purpose: they carry no caption, so there is never a sentence for the
   * annotation to accompany, and "the sender attached a file" is a poor description of an emoji.
   */
  private static attachmentTypeOf(message: proto.IMessage | null | undefined): string {
    if (!message) return ''

    if (message.videoMessage) return message.videoMessage.mimetype ?? 'video/mp4'
    if (message.documentMessage) return message.documentMessage.mimetype ?? 'application/octet-stream'
    if (message.imageMessage) return message.imageMessage.mimetype ?? 'image/jpeg'

    return ''
  }

  /** Whether a JID belongs to this session's own number (phone JID or LID). */
  private isSelf(jid: string | null | undefined): boolean {
    if (!jid) return false

    const me = [this.socket?.user?.id, this.socket?.user?.lid].filter(Boolean) as string[]

    return me.some((mine) => areJidsSameUser(jid, mine))
  }

  /** Remembers a message so a later outbound reply can quote it. */
  private cacheQuotable(msg: WAMessage): void {
    const id = msg.key?.id
    if (!id) return

    if (this.quotableStore.size > 500) {
      const oldest = this.quotableStore.keys().next().value
      if (oldest !== undefined) this.quotableStore.delete(oldest)
    }

    this.quotableStore.set(id, msg)
  }

  /**
   * Pulls the reply context out of an inbound message.
   * WhatsApp hangs it off whichever content type carries the text, so each is checked.
   */
  /** WhatsApp hangs contextInfo off whichever content type carries the text. */
  private static contextInfoOf(message: proto.IMessage): proto.IContextInfo | null | undefined {
    return (
      message.extendedTextMessage?.contextInfo ??
      message.imageMessage?.contextInfo ??
      message.videoMessage?.contextInfo ??
      message.documentMessage?.contextInfo
    )
  }

  private static readQuoteContext(
    contextInfo: proto.IContextInfo | null | undefined,
  ): Pick<InboundMessage, 'quotedMessageId' | 'quotedText'> {
    const quoted = contextInfo?.quotedMessage

    if (!contextInfo?.stanzaId || !quoted) return {}

    return {
      quotedMessageId: contextInfo.stanzaId,
      quotedText:
        quoted.conversation ??
        quoted.extendedTextMessage?.text ??
        quoted.imageMessage?.caption ??
        quoted.videoMessage?.caption ??
        '',
    }
  }

  async start(cb: WaCallbacks): Promise<void> {
    fs.mkdirSync(this.waDir, { recursive: true })

    const { state, saveCreds } = await useMultiFileAuthState(this.waDir)
    const { version } = await fetchLatestBaileysVersion()

    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, this.baileysLogger as never),
      },
      logger: this.baileysLogger as never,
      browser: Browsers.ubuntu('Chrome'),
      generateHighQualityLinkPreview: true,
      getMessage: async (key) => this.messageStore.get(key.id ?? '') ?? undefined,
    })
    this.socket = socket

    socket.ev.on('creds.update', saveCreds)

    socket.ev.on('connection.update', async (update) => {
      const { connection, qr, lastDisconnect } = update

      if (qr) {
        const qrcode = await import('qrcode')
        cb.onQr(await qrcode.toDataURL(qr))
      }

      if (connection === 'open') {
        const phoneNumber = socket.user?.id?.split(':')[0] ?? ''
        this.phoneNumber = phoneNumber
        this.log.info({ phoneNumber }, '[wa] connection open')
        cb.onConnected(phoneNumber)
      }

      if (connection === 'close') {
        this.socket = null
        this.phoneNumber = null
        const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut
        const reason = shouldReconnect ? `disconnected (code ${statusCode})` : 'logged out'
        this.log.warn({ statusCode, shouldReconnect }, '[wa] connection close')
        cb.onDisconnected(reason, shouldReconnect)
      }
    })

    /*
      Async, so a voice note can be transcribed before the message is forwarded. Awaiting inside the
      loop keeps the batch in order, which the debounce upstream depends on to gather one person's
      consecutive messages into a single turn.

      Declared here and subscribed below rather than passed to `on` directly: an async listener that
      rejects is an unhandled rejection, which modern Node treats as fatal. Handing it over with an
      explicit catch keeps one malformed message from taking the whole connector down.
    */
    const handleUpsert = async ({ messages, type }: { messages: WAMessage[]; type: string }) => {
      for (const msg of messages) this.cache(msg.key.id, msg.message)
      if (type !== 'notify') return

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue

        const from = msg.key.remoteJid ?? ''
        if (!from) continue

        // Baileys fills this from the stanza's addressing context, so for a LID-migrated contact
        // the phone number is right here — see Utils/decode-wa-message.
        const fromAlt = msg.key.remoteJidAlt ?? ''
        let text = WaSession.textOf(msg.message)

        /*
          Resolved here rather than at the callback, because the picture upload below needs it: the
          endpoint refuses a captionless picture that the room never addressed, and only this side
          knows whether it did.
        */
        const contextInfo = WaSession.contextInfoOf(msg.message)
        const isGroup = isJidGroup(from) ?? false
        const addressing = isGroup
          ? this.readAddressing(contextInfo)
          : { isAddressedToBot: true, mentionsOthers: false, quotedFromAgent: false }

        /*
          A voice note carries no text of any kind, so without this it falls out at the guard below
          and the sender is answered with silence — which is exactly what happened before this
          existed.

          The transcript takes the place of the text and nothing downstream is any the wiser. That
          is deliberate: the addressing rules, the group logic, the quote handling and everything
          upstream of the agent all work on words, and giving them words is cheaper and far less
          fragile than teaching each of them about audio.
        */
        const audio = msg.message.audioMessage
        let isVoiceNote = false
        let voiceSeconds = 0

        if (!text && audio) {
          voiceSeconds = audio.seconds ?? 0

          const transcript = await this.transcribeVoiceNote(msg, audio, voiceSeconds, cb)

          // No words, for any reason — a refusal upstream, a failed download, a silent recording.
          // Dropped rather than forwarded empty: an empty turn costs a model call and answers
          // nothing.
          if (!transcript) continue

          text = transcript
          isVoiceNote = true
        }

        /*
          The picture, hosted where the agent can look at it.

          Deliberately not folded into `text` the way a transcript is: a picture is not words, and
          the model reads it as its own content part. What it shares with the voice note is the
          ordering — the upload happens before the message is submitted, so everything upstream
          handles an ordinary message that carries a URL.

          A caption is left exactly as it arrived. The two cases WhatsApp allows are a picture on
          its own and a picture with a caption, and both now reach the agent whole; before this,
          the first was dropped here and the second arrived as text with the picture missing.
        */
        const imageUrls = await this.hostImages(msg, cb, {
          from,
          isGroup,
          // Unknown reads as addressed, which is the safe direction: the endpoint's guard exists to
          // avoid paying for a picture nothing will read, and paying for one is a far smaller
          // mistake than dropping a picture somebody sent us.
          isAddressedToBot: addressing.isAddressedToBot ?? true,
          hasText: text.length > 0,
        })

        /*
          The document, by the same route and for the same reason as the picture.

          Worth the trip even though the agent never sees the file itself: the platform extracts a
          PDF's text on upload and hands the agent the words, so "check this invoice" with a PDF
          attached becomes a question that can actually be answered.
        */
        const documents = await this.hostDocuments(msg, cb, {
          from,
          isGroup,
          isAddressedToBot: addressing.isAddressedToBot ?? true,
          hasText: text.length > 0,
        })

        // Nothing anyone can read. A sticker, a video with no caption, a reaction-shaped stray —
        // and, when the upload was refused, an attachment with no caption. Dropped rather than
        // forwarded empty: an empty turn costs a model call and answers nothing.
        if (!text && imageUrls.length === 0 && documents.length === 0) continue

        // Kept before the callback so the reply that follows can quote this exact message.
        this.cacheQuotable(msg)

        this.log.info(
          {
            from,
            fromAlt,
            messageId: msg.key.id,
            isGroup,
            isVoiceNote,
            voiceSeconds,
            images: imageUrls.length,
            documents: documents.length,
            textPreview: text.slice(0, 120),
          },
          '[in] ← inbound message forwarded to hub',
        )

        // Learned before the text is rewritten, so a message that mentions its own sender still
        // resolves. Cheap, and the only place a name is ever offered to us.
        this.rememberName(isGroup ? msg.key.participant : from, msg.pushName)

        cb.onMessage({
          from,
          fromAlt,
          // Names rather than ids, so the agent reads what a person reads. Falls through
          // unchanged for anyone whose name we have not learned — a raw id is ugly but honest,
          // and inventing one would be worse.
          text: this.namesForIds(text, contextInfo),
          messageId: msg.key.id ?? '',
          ...WaSession.readQuoteContext(contextInfo),
          isGroup,
          // In a group `from` is the group itself, so the individual comes off the key.
          senderJid: isGroup ? (msg.key.participant ?? '') : from,
          senderName: msg.pushName ?? '',
          groupName: isGroup ? this.groupSubject(from) : '',
          // Individual chats are always addressed to the bot; groups have to earn it. The other
          // two are group-only by nature — in a one-to-one chat there is nobody else to aim at.
          ...addressing,
          // What makes the answer eligible to be spoken. Upstream decides whether it actually is.
          isVoiceNote,
          voiceSeconds,
          imageUrls,
          documents,
          // Only when nothing was hosted: a picture the agent can see and a file whose text it has
          // are attachments it was given, not ones it was denied.
          unreadableAttachment:
            imageUrls.length > 0 || documents.length > 0
              ? ''
              : WaSession.attachmentTypeOf(msg.message),
        })
      }
    }

    socket.ev.on('messages.upsert', (event) => {
      void handleUpsert(event).catch((err) => this.log.error({ err }, '[in] ✖ inbound batch failed'))
    })

    // Reactions ride their own event. They carry no text, so the handler above discards them
    // (`if (!text) continue`) — without this subscription they are lost silently.
    socket.ev.on('messages.reaction', (events) => {
      for (const ev of events) {
        const from = ev.key?.remoteJid ?? ''
        const targetMessageId = ev.key?.id ?? ''

        if (!from || !targetMessageId) continue

        const isGroup = isJidGroup(from) ?? false
        // In a group the reactor is the participant; in a DM the chat itself is the reactor.
        const reactorJid = isGroup
          ? (ev.reaction?.key?.participant ?? '')
          : (ev.reaction?.key?.participant ?? ev.reaction?.key?.remoteJid ?? from)

        const reaction: InboundReaction = {
          from,
          // Read off the chat key, the same place and the same way the message path reads it.
          fromAlt: ev.key?.remoteJidAlt ?? '',
          emoji: ev.reaction?.text ?? '',
          targetMessageId,
          targetFromMe: ev.key?.fromMe ?? false,
          targetText: WaSession.textOf(this.quotableStore.get(targetMessageId)?.message),
          reactorJid,
          isGroup,
          groupName: isGroup ? this.groupSubject(from) : '',
          // Our own reactions echo back on this event. Reported rather than dropped here so
          // upstream can log the echo instead of wondering where it went.
          isFromSelf: (ev.reaction?.key?.fromMe ?? false) || this.isSelf(reactorJid),
        }

        this.log.info(
          {
            from,
            targetMessageId,
            targetFromMe: reaction.targetFromMe,
            emoji: reaction.emoji || '(removal)',
            isFromSelf: reaction.isFromSelf,
          },
          '[wa] ← inbound reaction',
        )

        cb.onReaction(reaction)
      }
    })
  }

  /**
   * Sends a text message, optionally as a WhatsApp reply to an earlier message.
   *
   * `quotedMessageId` is resolved against the inbound cache. An id that is no longer cached
   * (older than the last 500 messages, or lost to a restart) degrades to a normal message
   * rather than failing the send — the reply arriving unquoted beats it not arriving.
   */
  async sendMessage(to: string, text: string, quotedMessageId?: string): Promise<string> {
    if (!this.socket) throw new Error('WhatsApp socket is not connected')

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
    const quoted = quotedMessageId ? this.quotableStore.get(quotedMessageId) : undefined

    if (quotedMessageId && !quoted) {
      this.log.warn({ quotedMessageId }, '[wa] quoted message not in cache — sending unquoted')
    }

    // The agent writes "@Mega Syintia"; WhatsApp needs "@270875081363521" in the text plus the
    // jid in `mentions`, and renders the name back for whoever reads it.
    const { text: outgoing, mentions } = this.idsForNames(text)

    const result = await this.socket.sendMessage(
      jid,
      mentions.length > 0 ? { text: outgoing, mentions } : { text: outgoing },
      quoted ? { quoted } : undefined,
    )
    this.cache(result?.key?.id, result?.message)
    // Our own messages go in the quotable store too, so a reaction arriving on one of them can
    // be resolved back to its text without a round-trip.
    if (result) this.cacheQuotable(result)

    // WhatsApp's own id, which the caller reports upstream. Messenger-BE logs the message before
    // this point and therefore only knows its own correlation id until this comes back.
    return result?.key?.id ?? ''
  }

  /**
   * Reacts to an earlier message with a single emoji. An empty emoji removes our reaction.
   *
   * Baileys needs the full message key, which only the quotable store has. A target that is no
   * longer cached is logged and skipped rather than throwing: a reaction is decoration, and
   * failing here would take down the answer it was meant to accompany.
   */
  /**
   * Sends a spoken answer as a WhatsApp voice note.
   *
   * `ptt: true` is the whole difference between a voice note and a file attachment: the same bytes
   * without it arrive as a document with a download button. WhatsApp also insists on Ogg/Opus for
   * the voice-note bubble — anything else degrades to an attachment on some clients and refuses to
   * play on iOS — so the container is decided upstream, where the audio is generated, and this only
   * carries what it is given.
   *
   * No quoting and no mention rewriting, unlike `sendMessage`. A voice note has no text for a
   * mention to live in, and it follows the written answer it duplicates, which already carries
   * whatever quote the turn earned.
   */
  /**
   * Sends a picture, with its description as the caption.
   *
   * Baileys is handed the URL rather than the bytes and fetches it itself — which is why a photo
   * never has to cross the hub, where SignalR's receive limit lives. It also means the fetch happens
   * from wherever this connector runs, so the address has to be reachable from here; upstream only
   * ever sends public HTTP addresses for that reason.
   */
  async sendImageMessage(to: string, imageUrl: string, caption: string): Promise<string> {
    if (!this.socket) throw new Error('WhatsApp socket is not connected')

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`

    const result = await this.socket.sendMessage(jid, {
      image: { url: imageUrl },
      // Omitted rather than sent empty: an empty caption still gives the bubble a text area on some
      // clients, which reads as a message that failed to load.
      ...(caption ? { caption } : {}),
    })

    this.cache(result?.key?.id, result?.message)
    if (result) this.cacheQuotable(result)

    this.log.info({ jid, imageUrl, hasCaption: caption.length > 0 }, '[wa] → picture sent')

    return result?.key?.id ?? ''
  }

  async sendAudioMessage(
    to: string,
    audioBase64: string,
    seconds: number,
    mimeType: string,
  ): Promise<string> {
    if (!this.socket) throw new Error('WhatsApp socket is not connected')

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
    const audio = Buffer.from(audioBase64, 'base64')

    const result = await this.socket.sendMessage(jid, {
      audio,
      mimetype: mimeType || 'audio/ogg; codecs=opus',
      ptt: true,
      // Shown on the bubble before the audio is downloaded. Cosmetic, but a duration that
      // disagrees with what then plays reads as a broken client.
      seconds,
    })

    this.cache(result?.key?.id, result?.message)
    if (result) this.cacheQuotable(result)

    this.log.info({ jid, seconds, bytes: audio.length }, '[wa] → voice note sent')

    return result?.key?.id ?? ''
  }

  /**
   * Downloads a voice note and asks upstream to turn it into words.
   *
   * Returns null for every failure, and the caller drops the message on null. That is the same
   * outcome a voice note had before any of this existed, which makes every branch here safe: the
   * worst case is the behaviour we are replacing.
   *
   * The download is the part most likely to fail — WhatsApp expires media, and a note that has
   * been sitting in a queue while the connector was restarting may no longer be fetchable. Hence
   * the reupload request, which is Baileys' own retry for exactly that case.
   */
  private async transcribeVoiceNote(
    msg: WAMessage,
    audio: proto.Message.IAudioMessage,
    seconds: number,
    cb: WaCallbacks,
  ): Promise<string | null> {
    // No handler means this session was not built to spend money on audio. Voice notes are then
    // ignored exactly as they always were.
    if (!cb.transcribeVoiceNote) return null

    const messageId = msg.key?.id ?? ''
    const mimeType = audio.mimetype ?? 'audio/ogg'

    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: this.baileysLogger,
          // Bound through an arrow rather than passed by reference: the method reads `this` off the
          // socket, and handing it over bare loses it.
          reuploadRequest: (m) => this.socket!.updateMediaMessage(m),
        },
      )

      this.log.info(
        { messageId, seconds, bytes: buffer.length, mimeType, ptt: audio.ptt ?? false },
        '[in] voice note downloaded — asking for a transcript',
      )

      return await cb.transcribeVoiceNote(buffer, mimeType, seconds, messageId)
    } catch (err) {
      this.log.error({ err, messageId, seconds, mimeType }, '[in] ✖ could not download the voice note')

      return null
    }
  }

  /**
   * Downloads the picture a message carries and asks upstream to host it.
   *
   * Returns a list because that is what the payload carries, and because WhatsApp will eventually
   * be able to put more than one picture in a message — a list today costs nothing and saves a
   * protocol change later. It holds at most one url for now.
   *
   * Never throws and never drops the message: an empty list means "this message has no picture the
   * agent can see", which leaves a captioned picture answered on its caption. That is the
   * behaviour this channel had before any of this existed, which is what makes every branch here
   * safe.
   */
  private async hostImages(
    msg: WAMessage,
    cb: WaCallbacks,
    context: InboundImageContext,
  ): Promise<string[]> {
    // No handler means this session was not built to spend money on pictures. They are then
    // ignored exactly as they always were.
    if (!cb.hostImage) return []

    const image = WaSession.imageOf(msg.message)

    if (!image) return []

    const messageId = msg.key?.id ?? ''

    /*
      Refused before the transfer, not after.

      WhatsApp's own ceiling for a photo, so nothing a client produces reaches it — a phone
      re-encodes a photo to a couple of megabytes. It bounds the abnormal case, where the
      alternative is pulling tens of megabytes over the connector's link to have the endpoint
      refuse it anyway. The endpoint keeps its own, lower cap: this one is the protocol's limit,
      that one is the deployment's policy.
    */
    const maxBytes = 16 * 1024 * 1024

    if (image.fileLength > maxBytes) {
      this.log.warn(
        { messageId, bytes: image.fileLength, mimeType: image.mimeType },
        '[in] ✖ picture too large to fetch — message forwarded without it',
      )

      return []
    }

    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: this.baileysLogger,
          // Bound through an arrow rather than passed by reference: the method reads `this` off the
          // socket, and handing it over bare loses it.
          reuploadRequest: (m) => this.socket!.updateMediaMessage(m),
        },
      )

      this.log.info(
        { messageId, bytes: buffer.length, mimeType: image.mimeType, hasCaption: context.hasText },
        '[in] picture downloaded — asking for somewhere to put it',
      )

      const url = await cb.hostImage(buffer, image.mimeType, messageId, context)

      return url ? [url] : []
    } catch (err) {
      this.log.error(
        { err, messageId, mimeType: image.mimeType },
        '[in] ✖ could not download the picture',
      )

      return []
    }
  }

  /**
   * Downloads the document a message carries and asks upstream to host it.
   *
   * Every branch returns an empty list, which reads as "no file the agent can read" and leaves the
   * message to be answered on its caption with the file named instead — which is what every
   * attachment on this channel got until now, so nothing here can be worse than what it replaces.
   */
  private async hostDocuments(
    msg: WAMessage,
    cb: WaCallbacks,
    context: InboundImageContext,
  ): Promise<InboundDocument[]> {
    if (!cb.hostDocument) return []

    const document = WaSession.documentOf(msg.message)

    if (!document) return []

    const messageId = msg.key?.id ?? ''

    // Refused before the transfer rather than after, as with a picture. Higher than the picture's
    // ceiling because a document has no smaller version of itself to send.
    const maxBytes = 20 * 1024 * 1024

    if (document.fileLength > maxBytes) {
      this.log.warn(
        { messageId, bytes: document.fileLength, fileName: document.fileName },
        '[in] ✖ document too large to fetch — message forwarded without it',
      )

      return []
    }

    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: this.baileysLogger,
          reuploadRequest: (m) => this.socket!.updateMediaMessage(m),
        },
      )

      this.log.info(
        { messageId, bytes: buffer.length, fileName: document.fileName, hasCaption: context.hasText },
        '[in] document downloaded — asking for somewhere to put it',
      )

      const url = await cb.hostDocument(
        buffer,
        document.mimeType,
        document.fileName,
        messageId,
        context,
      )

      return url ? [{ url, fileName: document.fileName }] : []
    } catch (err) {
      this.log.error(
        { err, messageId, fileName: document.fileName },
        '[in] ✖ could not download the document',
      )

      return []
    }
  }

  async sendReaction(to: string, emoji: string, targetMessageId: string): Promise<void> {
    if (!this.socket) throw new Error('WhatsApp socket is not connected')

    const target = this.quotableStore.get(targetMessageId)

    if (!target?.key) {
      this.log.warn({ targetMessageId, emoji }, '[wa] reaction target not in cache — skipped')
      return
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`

    await this.socket.sendMessage(jid, { react: { text: emoji, key: target.key } })
    this.log.info({ jid, targetMessageId, emoji }, '[wa] → reaction sent')
  }

  /**
   * Finds the LID a phone number answers to, asking WhatsApp when we have not seen it before.
   *
   * This direction, and not the other one, because Baileys' mapping store is asymmetric:
   * `getLIDsForPNs` falls through to a USync query against WhatsApp, while `getPNsForLIDs`
   * reads the local store and stops there. So a LID cannot be turned into a number on demand,
   * but a number can — and a number is the only thing an operator can type.
   *
   * Returns null when it cannot be resolved. That is not an error: the number may not be on
   * WhatsApp, or may never have been migrated to a LID, and both mean "nothing to link".
   */
  async resolveLid(pn: string): Promise<string | null> {
    if (!this.socket) {
      this.log.warn({ pn }, '[lid] ✖ Cannot resolve — WhatsApp socket is not connected')
      return null
    }

    const jid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`

    if (jid.endsWith('@lid') || jid.endsWith('@g.us')) {
      this.log.debug({ pn }, '[lid] Nothing to resolve — already a LID or a group')
      return null
    }

    try {
      const raw = await (this.socket as any).signalRepository?.lidMapping?.getLIDForPN(jid)

      // Baileys hands back a device-scoped address (`<id>:3@lid`) whenever the number it was
      // given carried a device. A 1:1 chat's `remoteJid` never does, so the bare form is the one
      // a contact rule has to be stored under — the suffixed one would never match.
      const lid = typeof raw === 'string' ? raw.replace(/:\d+@lid$/, '@lid') : null

      // Logged either way, and at info: this is the one line that says whether WhatsApp will
      // hand over the pairing for a given number, and the contact rules stand or fall on it.
      this.log.info({ pn: jid, raw: raw ?? null, lid }, lid
        ? '[lid] ✔ Resolved phone number to LID'
        : '[lid] — WhatsApp returned no LID for this number')

      return lid
    } catch (err) {
      this.log.error({ err, pn: jid }, '[lid] ✖ LID lookup threw')
      return null
    }
  }

  /**
   * Takes this number out of a group.
   *
   * The one action here that cannot be undone from our side: WhatsApp requires a fresh invite
   * from a member to put the agent back, so nothing upstream may offer a re-join. Leaving needs
   * no admin rights — a member can always walk out.
   *
   * Returns whether WhatsApp accepted it, which is not the same as whether the server thinks the
   * agent has left: the policy is stamped before the command is dispatched, deliberately, because
   * an offline connector never receives it and a record that hides a departure is worse than one
   * that overstates it.
   */
  async leaveGroup(jid: string): Promise<boolean> {
    if (!this.socket) {
      this.log.warn({ jid }, '[group] ✖ Cannot leave — WhatsApp socket is not connected')
      return false
    }

    // Guarded rather than trusted. `groupLeave` on a non-group id is a malformed stanza sent to
    // WhatsApp's servers, and the address arrives over the wire from another service.
    if (!jid.endsWith('@g.us')) {
      this.log.warn({ jid }, '[group] ✖ Refusing to leave — not a group address')
      return false
    }

    try {
      await this.socket.groupLeave(jid)
      this.log.info({ jid }, '[group] ✔ Left the group')
      return true
    } catch (err) {
      this.log.error({ err, jid }, '[group] ✖ groupLeave threw')
      return false
    }
  }

  async logout(): Promise<void> {
    if (this.socket) {
      try { await this.socket.logout() } catch { /* already disconnected */ }
      this.socket = null
    }
    if (fs.existsSync(this.waDir)) fs.rmSync(this.waDir, { recursive: true, force: true })
  }

  stop(): void {
    if (this.socket) {
      try { this.socket.end(undefined) } catch { /* ignore */ }
      this.socket = null
    }
  }
}
