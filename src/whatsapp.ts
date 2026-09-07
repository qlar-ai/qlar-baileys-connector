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
import pino from 'pino'
import { APP_DIR } from './appDir'

const WA_SESSION_DIR = path.join(APP_DIR, 'wa_session')

export interface InboundMessage {
  from: string
  /**
   * The same contact's other address, when WhatsApp supplies one — the phone JID for a
   * LID-migrated contact, since `from` is then `<id>@lid`.
   *
   * Load-bearing rather than diagnostic: an operator blacklists or whitelists a phone
   * number, because nobody knows their own contacts' LIDs, and without this the rule is
   * stored against an address no inbound message ever arrives under. Empty means WhatsApp
   * told us nothing — which is *unknown*, never "this contact has no number".
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
   * Whether the message @mentions somebody who is not the bot.
   *
   * The cheapest possible "this is not for us": an @ of another member is a message aimed at
   * that member, and knowing so costs nothing and no model call. Resolved here for the same
   * reason as `isAddressedToBot` — the comparison needs the bot's own JID *and* LID.
   */
  mentionsOthers?: boolean
  /**
   * When this message quotes another, whether the quoted message was the bot's own.
   *
   * Distinct from `quotedMessageId` being present, and the distinction is the whole point: a
   * reply to the bot is addressed to it, while a reply to another member is addressed to that
   * member. Meaningless when nothing is quoted, and false in that case.
   */
  quotedFromAgent?: boolean
  /**
   * True when this arrived as a voice note. `text` is then the transcript, resolved before the
   * message was forwarded — everything downstream reads an ordinary text message.
   */
  isVoiceNote?: boolean
  /** How long the voice note was, as WhatsApp reported it. Diagnostic only. */
  voiceSeconds?: number
}

export type OnQr = (qrBase64: string) => void
export type OnConnected = (phoneNumber: string) => void
export type OnDisconnected = (reason: string, shouldReconnect: boolean) => void
export type OnMessage = (msg: InboundMessage) => void

/**
 * Turns a downloaded voice note into words, by asking Messenger-BE.
 *
 * Passed in rather than done here because only the hub layer knows how to reach Messenger-BE, and
 * because the answer is not this module's to decide: the reply says whether the channel is even set
 * up to pay for transcription. Null means "no words" for any reason — a refusal upstream included —
 * and the message is then dropped, exactly as an untranscribed voice note has always been.
 */
export type OnTranscribeVoiceNote = (
  audio: Buffer,
  mimeType: string,
  seconds: number,
  messageId: string,
) => Promise<string | null>

// ───────────────────────────────────────────────────────────────────────────
// Diagnostics
//
// `log`            — our own connector tracing (human-facing). Verbosity via
//                    WA_LOG_LEVEL (default 'debug'): trace|debug|info|warn|error.
// `baileysLogger`  — Baileys' OWN internal logger. It prints the RAW WhatsApp
//                    protocol frames Baileys exchanges with WA servers. Off by
//                    default (extremely chatty). Set BAILEYS_LOG_LEVEL=trace (or
//                    debug) to see the actual request/response traffic — this is
//                    the ground truth for "what did WhatsApp's API reply".
// `WA_DEBUG_PROBE=1` — additionally runs onWhatsApp() before each send (a network
//                    round-trip that asks WA whether the number exists).
// ───────────────────────────────────────────────────────────────────────────
const log = pino({ level: process.env.WA_LOG_LEVEL ?? 'debug' })
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'silent' })

// proto.WebMessageInfo.Status enum → readable name.
const MESSAGE_STATUS: Record<number, string> = {
  0: 'ERROR',
  1: 'PENDING',
  2: 'SERVER_ACK', // reached WhatsApp servers
  3: 'DELIVERY_ACK', // delivered to the recipient's device
  4: 'READ',
  5: 'PLAYED',
}
function statusName(status?: number | null): string {
  if (status === null || status === undefined) return 'UNKNOWN'
  return MESSAGE_STATUS[status] ?? `UNKNOWN(${status})`
}

// Fully expand an error — Baileys throws Boom errors that hide the real cause
// inside nested .output / .data fields.
function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const e = err as any
    return {
      name: err.name,
      message: err.message,
      statusCode: e?.output?.statusCode ?? e?.statusCode,
      boomPayload: e?.output?.payload,
      data: e?.data,
      stack: err.stack,
    }
  }
  return { raw: String(err) }
}

// Cache of recently sent/seen messages so getMessage() can answer retry receipts
// (a recipient device that fails to decrypt asks us to re-send). Required for
// reliable delivery; replaces Baileys' removed makeInMemoryStore.
const messageStore = new Map<string, proto.IMessage>()

// Full inbound messages kept so a later reply can quote them. Baileys needs the whole
// WAMessage (key + content) to build the quote, not just the content `messageStore` holds.
const quotableStore = new Map<string, WAMessage>()

function cacheQuotable(msg: WAMessage): void {
  const id = msg.key?.id
  if (!id) return

  if (quotableStore.size > 500) {
    const oldest = quotableStore.keys().next().value
    if (oldest !== undefined) quotableStore.delete(oldest)
  }

  quotableStore.set(id, msg)
}

// Group subjects, warmed in the background. A miss just means the first message from a group
// carries no name — never worth blocking message delivery on a metadata round-trip.
const groupSubjects = new Map<string, string>()

/*
  Display names, learned as people speak — see the same maps in `server/waSession.ts`.

  WhatsApp does not put names in a message's text. Somebody typing "@Mega Syintia" sends
  "@270875081363521"; the name is rendered by the reader's own client from `mentionedJid`. Without
  this, the agent reads an id and repeats it back.
*/
const displayNames = new Map<string, string>()
// The full jid each person was last seen under. A mention must go back out in the domain the room
// actually uses — a lid room will not resolve an @s.whatsapp.net jid.
const knownJids = new Map<string, string>()

/** The numeric part of a jid — the form a mention takes inside message text. */
function jidDigits(jid: string): string {
  return jid.split('@')[0]?.split(':')[0] ?? ''
}

/**
 * Records every member of a group, so a mention does not depend on having heard them speak.
 *
 * Names are taken only when WhatsApp supplies one — `notify`/`name` are usually blank in a LID
 * room unless the person is in your address book. The jid is the part that matters: with it,
 * "@<id>" in an outgoing message becomes a real mention even for somebody with no name at all,
 * and a saved contact was never required for that.
 */
function rememberParticipants(
  participants: { id?: string | null; name?: string | null; notify?: string | null }[] | null | undefined,
): void {
  if (!participants) return

  for (const p of participants) {
    const digits = jidDigits(p?.id ?? '')
    if (!digits) continue

    // Never downgrade a name learned from speech, which is the more current of the two.
    if (!knownJids.has(digits)) knownJids.set(digits, p.id!)

    const supplied = (p.notify ?? p.name ?? '').trim()
    if (supplied && !displayNames.has(digits)) displayNames.set(digits, supplied)
  }
}

/** Records somebody's display name against the digits of their jid. */
function rememberName(jid: string | null | undefined, pushName: string | null | undefined): void {
  if (!jid || !pushName) return

  const digits = jidDigits(jid)
  if (!digits) return

  displayNames.set(digits, pushName.trim())
  knownJids.set(digits, jid)
}

/**
 * Rewrites "@<id>" in inbound text to "@<display name>".
 *
 * Driven by `mentionedJid` rather than by scanning for digit runs, so a price or a year in a
 * sentence is never mistaken for a mention. An id with no known name is left as it arrived.
 */
function namesForIds(text: string, contextInfo: proto.IContextInfo | null | undefined): string {
  const mentioned = contextInfo?.mentionedJid ?? []
  if (mentioned.length === 0) return text

  let out = text

  for (const jid of mentioned) {
    const digits = jidDigits(jid ?? '')
    if (!digits) continue

    const name = displayNames.get(digits)
    if (!name) continue

    out = out.split(`@${digits}`).join(`@${name}`)
  }

  return out
}

/**
 * Turns "@<display name>" in an outgoing message back into a real WhatsApp mention.
 *
 * Longest name first, so "@Mega Syintia" is not half-matched by a "@Mega" who also exists. An
 * unresolved name stays plain text: the worst outcome is a mention that does not light up, never
 * one pointing at the wrong person.
 */
function idsForNames(text: string): { text: string; mentions: string[] } {
  if (!text.includes('@')) return { text, mentions: [] }

  let out = text

  // Names first, longest wins, so "@Mega Syintia" is not half-matched by a "@Mega" who exists.
  const byLongestName = [...displayNames.entries()].sort(([, a], [, b]) => b.length - a.length)

  for (const [digits, name] of byLongestName) {
    if (!name) continue

    const needle = `@${name}`
    if (!out.includes(needle)) continue

    out = out.split(needle).join(`@${digits}`)
  }

  /*
    Then collect ids — the same scan for both routes. Names have just become ids above, and an id
    may also have been written directly, for a member nobody has a name for. Both are the wire form
    a mention needs, so the cases converge here.

    Only recognised ids are claimed; an unknown one stays plain text.
  */
  const mentions = [
    ...new Set(
      [...out.matchAll(/@(\d{5,})/g)]
        .map((m) => m[1]!)
        .filter((digits) => knownJids.has(digits))
        .map((digits) => knownJids.get(digits)!),
    ),
  ]

  return { text: out, mentions }
}

/**
 * Returns the cached group subject, kicking off a lookup when it is not known yet.
 * Deliberately non-blocking so later messages cannot overtake earlier ones.
 *
 * A failed or empty lookup **forgets the key** rather than caching the empty string, and that is
 * the whole point of the retry. Reserving the key and leaving it reserved is what made some groups
 * permanently nameless: the reservation reads as a cached answer, so a lookup that failed once —
 * because the socket was mid-reconnect, or WhatsApp rate-limited the metadata call — was never
 * retried for the life of the process, however many messages arrived from that group afterwards.
 */
function groupSubject(jid: string): string {
  const cached = groupSubjects.get(jid)

  if (cached) return cached

  // No socket, no lookup — and crucially no reservation either, or the next message would read
  // the reservation as a cached answer and never try again.
  if (!activeSocket) return ''

  // A reservation only while a lookup is genuinely in flight, so concurrent messages from the
  // same group don't each fire one.
  if (cached === '') return ''

  groupSubjects.set(jid, '')

  void activeSocket
    .groupMetadata(jid)
    .then((meta) => {
      // Free ride on a lookup already happening: participants give us every member's jid whether
      // they have spoken or not, which is what lets the agent mention somebody silent.
      rememberParticipants(meta?.participants)

      const subject = meta?.subject ?? ''

      if (subject) {
        groupSubjects.set(jid, subject)
        log.info({ jid, subject }, '[wa] group subject resolved')
        return
      }

      // Resolved to nothing. Forget it rather than caching the emptiness: a group with a genuinely
      // blank subject costs one cheap lookup per message, and a group that was renamed after a
      // blank answer gets its name.
      groupSubjects.delete(jid)
    })
    .catch((err) => {
      // Dropped so the next message retries. This is the line that was missing.
      groupSubjects.delete(jid)
      log.warn({ err, jid }, '[wa] group metadata lookup failed — will retry on the next message')
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
 * The bot has two identities — its phone JID and its LID — and a mention may arrive as either,
 * so both are compared. Matching only the phone number would leave the bot deaf in every
 * LID-migrated group.
 */
function readAddressing(
  contextInfo: proto.IContextInfo | null | undefined,
): Pick<InboundMessage, 'isAddressedToBot' | 'mentionsOthers' | 'quotedFromAgent'> {
  const me = [activeSocket?.user?.id, activeSocket?.user?.lid].filter(Boolean) as string[]

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

  // Present only when something is quoted, and it is the *author* of the quoted message — so
  // this is "did they reply to us" rather than "did they reply at all".
  const quotedAuthor = contextInfo?.participant
  const quotedFromAgent = isMe(quotedAuthor)

  return {
    isAddressedToBot: mentionsBot || quotedFromAgent,
    mentionsOthers,
    quotedFromAgent,
  }
}

/** WhatsApp hangs contextInfo off whichever content type carries the text. */
function contextInfoOf(message: proto.IMessage): proto.IContextInfo | null | undefined {
  return (
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.documentMessage?.contextInfo
  )
}

/** Pulls the reply context out of an inbound message. */
function readQuoteContext(
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
function cacheMessage(id: string | null | undefined, message: proto.IMessage | null | undefined): void {
  if (!id || !message) return
  if (messageStore.size > 2000) {
    const oldest = messageStore.keys().next().value
    if (oldest !== undefined) messageStore.delete(oldest)
  }
  messageStore.set(id, message)
}

let activeSocket: WASocket | null = null

export async function startWhatsApp(
  onQr: OnQr,
  onConnected: OnConnected,
  onDisconnected: OnDisconnected,
  onMessage: OnMessage,
  // Optional, and last, so nothing that calls this without it changes behaviour: voice notes are
  // then ignored exactly as they were before any of this existed.
  onTranscribeVoiceNote?: OnTranscribeVoiceNote,
): Promise<void> {
  fs.mkdirSync(WA_SESSION_DIR, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(WA_SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()
  log.info(
    { waVersion: version, sessionDir: WA_SESSION_DIR, node: process.version },
    '[wa] startWhatsApp — creating socket',
  )

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as any),
    },
    logger: baileysLogger as any,
    browser: Browsers.ubuntu('Chrome'),
    generateHighQualityLinkPreview: true,
    // Serve cached messages so Baileys can fulfil retry receipts (real delivery).
    getMessage: async (key) => messageStore.get(key.id ?? '') ?? undefined,
  })

  activeSocket = socket

  socket.ev.on('creds.update', saveCreds)

  socket.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update

    log.debug(
      {
        connection,
        hasQr: !!qr,
        isNewLogin: (update as any).isNewLogin,
        receivedPendingNotifications: update.receivedPendingNotifications,
        lastDisconnect: lastDisconnect ? describeError(lastDisconnect.error) : undefined,
      },
      '[conn] connection.update',
    )

    if (qr) {
      // Convert raw QR string to base64 data URL for display in CMS-Web
      const qrcode = await import('qrcode')
      const qrBase64 = await qrcode.toDataURL(qr)
      onQr(qrBase64)
    }

    if (connection === 'open') {
      log.info(
        {
          meId: socket.user?.id,
          meLid: (socket.user as any)?.lid,
          meName: socket.user?.name,
        },
        '[conn] ✅ connection OPEN — socket ready to send/receive',
      )
      const phoneNumber = socket.user?.id?.split(':')[0] ?? ''
      onConnected(phoneNumber)
    }

    if (connection === 'close') {
      activeSocket = null
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      const reason = shouldReconnect ? `disconnected (code ${statusCode})` : 'logged out'
      log.warn(
        { statusCode, shouldReconnect, reason, error: describeError(lastDisconnect?.error) },
        '[conn] ❌ connection CLOSE — activeSocket set to null (sends will fail until reconnect)',
      )
      onDisconnected(reason, shouldReconnect)
    }
  })

  /*
    Async, so a voice note can be transcribed before the message is forwarded. Awaiting inside the
    loop keeps the batch in order, which the debounce upstream relies on to gather one person's
    consecutive messages into a single turn.

    Declared here and subscribed below rather than passed to `on` directly: an async listener that
    rejects is an unhandled rejection, which modern Node treats as fatal. Handing it over with an
    explicit catch keeps one malformed message from taking the whole connector down.
  */
  const handleUpsert = async ({ messages, type }: { messages: WAMessage[]; type: string }) => {
    // Cache every message (sent + received) so getMessage() can answer retries.
    for (const msg of messages) cacheMessage(msg.key.id, msg.message)
    log.debug({ type, count: messages.length }, '[in] messages.upsert')
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const from = msg.key.remoteJid ?? ''
      if (!from) continue

      // Baileys fills this from the stanza's addressing context, so for a LID-migrated
      // contact the phone number is right here — see Utils/decode-wa-message.
      const fromAlt = msg.key.remoteJidAlt ?? ''
      let text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        msg.message.imageMessage?.caption ??
        ''

      /*
        A voice note carries no text of any kind, so without this it falls out at the guard below
        and the sender is answered with silence — which is what happened before this existed.

        The transcript takes the place of the text and nothing downstream is any the wiser, which
        is deliberate: the addressing rules, the group logic and everything upstream of the agent
        all work on words, and giving them words is far less fragile than teaching each of them
        about audio.
      */
      const audio = msg.message.audioMessage
      let isVoiceNote = false
      let voiceSeconds = 0

      if (!text && audio) {
        voiceSeconds = audio.seconds ?? 0

        const transcript = await transcribeVoiceNote(msg, audio, voiceSeconds, onTranscribeVoiceNote)

        // No words, for any reason — a refusal upstream, a failed download, a silent recording.
        // Dropped rather than forwarded empty: an empty turn costs a model call and answers nothing.
        if (!transcript) continue

        text = transcript
        isVoiceNote = true
      }

      if (!text) continue

      // Kept before the callback so the reply that follows can quote this exact message.
      cacheQuotable(msg)

      const contextInfo = contextInfoOf(msg.message)
      const isGroup = isJidGroup(from) ?? false

      log.info(
        { from, fromAlt, messageId: msg.key.id, isGroup, isVoiceNote, voiceSeconds, textPreview: text.slice(0, 120) },
        '[in] ← inbound message forwarded to hub',
      )

      // Learned before the text is rewritten, so a message mentioning its own sender resolves too.
      rememberName(isGroup ? msg.key.participant : from, msg.pushName)

      onMessage({
        from,
        fromAlt,
        // Names rather than ids, so the agent reads what a person reads.
        text: namesForIds(text, contextInfo),
        messageId: msg.key.id ?? '',
        ...readQuoteContext(contextInfo),
        isGroup,
        // In a group `from` is the group itself, so the individual comes off the key.
        senderJid: isGroup ? (msg.key.participant ?? '') : from,
        senderName: msg.pushName ?? '',
        groupName: isGroup ? groupSubject(from) : '',
        // Individual chats are always addressed to the bot; groups have to earn it. The other two
        // are group-only by nature — in a one-to-one chat there is nobody else to be aiming at.
        ...(isGroup
          ? readAddressing(contextInfo)
          : { isAddressedToBot: true, mentionsOthers: false, quotedFromAgent: false }),
        // What makes the answer eligible to be spoken. Upstream decides whether it actually is.
        isVoiceNote,
        voiceSeconds,
      })
    }
  }

  socket.ev.on('messages.upsert', (event) => {
    void handleUpsert(event).catch((err) =>
      log.error({ err: describeError(err) }, '[in] ✖ inbound batch failed'),
    )
  })

  // Outbound delivery lifecycle — this is WhatsApp telling us what happened to a
  // message WE sent. Cross-reference the `id` here with the messageId logged at
  // STEP 4 of sendMessage(). If you only ever see SERVER_ACK and never
  // DELIVERY_ACK, the message reached WhatsApp's servers but never reached the
  // recipient's device.
  socket.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      log.info(
        {
          id: u.key?.id,
          remoteJid: u.key?.remoteJid,
          fromMe: u.key?.fromMe,
          status: u.update?.status,
          statusName: statusName(u.update?.status as number | null | undefined),
          update: u.update,
        },
        '[ack] messages.update — WhatsApp delivery/status change',
      )
    }
  })

  socket.ev.on('message-receipt.update', (updates) => {
    for (const u of updates) {
      log.info(
        {
          id: u.key?.id,
          remoteJid: u.key?.remoteJid,
          fromMe: u.key?.fromMe,
          receipt: u.receipt,
        },
        '[ack] message-receipt.update — per-recipient receipt',
      )
    }
  })
}

/**
 * Downloads a voice note and asks the hub layer to turn it into words.
 *
 * Returns null for every failure, and the caller drops the message on null. That is the same
 * outcome a voice note had before any of this existed, which makes every branch here safe: the
 * worst case is the behaviour being replaced.
 *
 * The download is the part most likely to fail — WhatsApp expires media, and a note that sat in a
 * queue while the connector was restarting may no longer be fetchable. Hence the reupload request,
 * which is Baileys' own retry for exactly that case.
 */
async function transcribeVoiceNote(
  msg: WAMessage,
  audio: proto.Message.IAudioMessage,
  seconds: number,
  onTranscribeVoiceNote?: OnTranscribeVoiceNote,
): Promise<string | null> {
  // No handler means this build was not wired to spend money on audio. Voice notes are then
  // ignored exactly as they always were.
  if (!onTranscribeVoiceNote || !activeSocket) return null

  const messageId = msg.key?.id ?? ''
  const mimeType = audio.mimetype ?? 'audio/ogg'

  try {
    const buffer = await downloadMediaMessage(
      msg,
      'buffer',
      {},
      {
        logger: baileysLogger as any,
        // Bound through an arrow rather than passed by reference: the method reads `this` off the
        // socket, and handing it over bare loses it.
        reuploadRequest: (m) => activeSocket!.updateMediaMessage(m),
      },
    )

    log.info(
      { messageId, seconds, bytes: buffer.length, mimeType, ptt: audio.ptt ?? false },
      '[in] voice note downloaded — asking for a transcript',
    )

    return await onTranscribeVoiceNote(buffer, mimeType, seconds, messageId)
  } catch (err) {
    log.error({ err: describeError(err), messageId, seconds, mimeType }, '[in] ✖ could not download the voice note')

    return null
  }
}

/**
 * Sends a spoken answer as a WhatsApp voice note.
 *
 * `ptt: true` is the whole difference between a voice note and a file attachment: the same bytes
 * without it arrive as a document with a download button. WhatsApp also insists on Ogg/Opus for the
 * voice-note bubble — anything else degrades to an attachment on some clients and refuses to play on
 * iOS — so the container is decided upstream, where the audio is generated, and this carries what
 * it is given.
 *
 * No quoting and no mention rewriting, unlike `sendMessage`. A voice note has no text for a mention
 * to live in, and it follows the written answer it duplicates, which already carries whatever quote
 * the turn earned.
 */
export async function sendAudioMessage(
  to: string,
  audioBase64: string,
  seconds: number,
  mimeType: string,
): Promise<void> {
  if (!activeSocket) {
    log.error({ to }, '[send] ✖ no active socket — voice note not sent')
    throw new Error('WhatsApp socket is not connected')
  }

  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
  const audio = Buffer.from(audioBase64, 'base64')

  const result = await activeSocket.sendMessage(jid, {
    audio,
    mimetype: mimeType || 'audio/ogg; codecs=opus',
    ptt: true,
    // Shown on the bubble before the audio is downloaded. Cosmetic, but a duration that disagrees
    // with what then plays reads as a broken client.
    seconds,
  })

  cacheMessage(result?.key?.id, result?.message)
  if (result) cacheQuotable(result)

  log.info({ jid, seconds, bytes: audio.length, messageId: result?.key?.id }, '[send] ✔ voice note sent')
}

/**
 * Sends a text message, optionally as a WhatsApp reply to an earlier message.
 *
 * `quotedMessageId` is resolved against the inbound cache. An id that is no longer cached
 * (older than the last 500 messages, or lost to a restart) degrades to a normal message
 * rather than failing the send — the reply arriving unquoted beats it not arriving.
 */
export async function sendMessage(to: string, text: string, quotedMessageId?: string): Promise<void> {
  const startedAt = Date.now()

  // ── STEP 1: BEFORE PAYLOAD — what we were asked to send ────────────────────
  log.info(
    { to, textLength: text?.length ?? 0, textPreview: (text ?? '').slice(0, 200) },
    '[send] ▶ STEP 1 — sendMessage() invoked',
  )

  if (!activeSocket) {
    log.error({ to }, '[send] ✖ ABORT — activeSocket is null (WhatsApp socket not connected)')
    throw new Error('WhatsApp socket is not connected')
  }

  // Use the JID as-is if it already has a suffix (@s.whatsapp.net or @lid), otherwise default to @s.whatsapp.net
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`

  // ── STEP 2: socket + JID state right before sending ────────────────────────
  const ws = (activeSocket as any).ws
  log.debug(
    {
      to,
      resolvedJid: jid,
      jidType: jid.endsWith('@lid') ? 'lid' : jid.endsWith('@g.us') ? 'group' : 'pn',
      wsReadyState: ws?.readyState, // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
      wsIsOpen: ws?.readyState === 1,
      meId: activeSocket.user?.id,
      meLid: (activeSocket.user as any)?.lid,
    },
    '[send] STEP 2 — JID resolved + socket state (before sending payload)',
  )

  // ── STEP 2b (opt-in): ask WhatsApp whether this number exists / its real JID.
  // Extra network round-trip; enable with WA_DEBUG_PROBE=1.
  if (process.env.WA_DEBUG_PROBE === '1') {
    try {
      const probe = await activeSocket.onWhatsApp(jid)
      log.debug({ jid, probe }, '[send] STEP 2b — onWhatsApp() existence probe')
    } catch (e) {
      log.warn({ jid, error: describeError(e) }, '[send] STEP 2b — onWhatsApp() probe failed')
    }
  }

  const quoted = quotedMessageId ? quotableStore.get(quotedMessageId) : undefined

  if (quotedMessageId && !quoted) {
    log.warn({ quotedMessageId }, '[send] quoted message not in cache — sending unquoted')
  }

  // ── STEP 3: the actual payload leaving for WhatsApp ────────────────────────
  log.debug(
    { jid, payload: { text }, quotingMessageId: quotedMessageId ?? null, quoteResolved: !!quoted },
    '[send] STEP 3 — calling sock.sendMessage() (payload about to be encrypted + pushed to WhatsApp)',
  )

  try {
    // The agent writes "@Mega Syintia"; WhatsApp needs the id in the text plus the jid in
    // `mentions`, and renders the name back for whoever reads it.
    const { text: outgoing, mentions } = idsForNames(text)

    const result = await activeSocket.sendMessage(
      jid,
      mentions.length > 0 ? { text: outgoing, mentions } : { text: outgoing },
      quoted ? { quoted } : undefined,
    )
    cacheMessage(result?.key?.id, result?.message)
    log.info(`test phil ${JSON.stringify(result)}`)

    // ── STEP 4: AFTER PAYLOAD — what Baileys returned (the local WA stanza) ───
    log.info(
      {
        to,
        jid,
        elapsedMs: Date.now() - startedAt,
        messageId: result?.key?.id,
        remoteJid: result?.key?.remoteJid,
        fromMe: result?.key?.fromMe,
        status: result?.status,
        statusName: statusName(result?.status as number | null | undefined),
      },
      '[send] ✔ STEP 4 — sock.sendMessage() RESOLVED (Baileys built + queued the stanza)',
    )
    // Full WebMessageInfo for deep inspection (visible at debug level).
    log.debug({ jid, fullResult: result }, '[send] STEP 4b — full WebMessageInfo returned by Baileys')

    log.info(
      {
        messageId: result?.key?.id,
        note: 'Now watch [ack] messages.update for this id: SERVER_ACK = reached WA servers, DELIVERY_ACK = reached recipient device. No DELIVERY_ACK ⇒ it never reached the user.',
      },
      '[send] STEP 5 — awaiting async delivery acks from WhatsApp',
    )
  } catch (err) {
    // ── STEP 4 (failure): the push to WhatsApp threw ─────────────────────────
    log.error(
      { to, jid, elapsedMs: Date.now() - startedAt, error: describeError(err) },
      '[send] ✖ STEP 4 — sock.sendMessage() THREW (failed to push payload to WhatsApp)',
    )
    throw err
  }
}

/**
 * Finds the LID a phone number answers to, asking WhatsApp when we have not seen it before.
 *
 * This direction, and not the other one, because Baileys' mapping store is asymmetric:
 * `getLIDsForPNs` falls through to a USync query against WhatsApp, while `getPNsForLIDs`
 * reads the local store and stops there. So a LID cannot be turned into a number on demand,
 * but a number can always be turned into a LID — which is the one an operator can type.
 *
 * Returns null when it cannot be resolved. That is not an error: the number may not be on
 * WhatsApp, or may never have been migrated to a LID at all, and both mean "nothing to link"
 * rather than "something went wrong".
 */
export async function resolveLid(pn: string): Promise<string | null> {
  if (!activeSocket) {
    log.warn({ pn }, '[lid] ✖ Cannot resolve — WhatsApp socket is not connected')
    return null
  }

  const jid = pn.includes('@') ? pn : `${pn}@s.whatsapp.net`

  if (jid.endsWith('@lid') || jid.endsWith('@g.us')) {
    log.debug({ pn }, '[lid] Nothing to resolve — already a LID or a group')
    return null
  }

  try {
    const raw = await (activeSocket as any).signalRepository?.lidMapping?.getLIDForPN(jid)

    // Baileys hands back a device-scoped address (`<id>:3@lid`) whenever the number it was given
    // carried a device. A 1:1 chat's `remoteJid` never does, so the bare form is the one a contact
    // rule has to be stored under — the suffixed one would be a string that never matches.
    const lid = typeof raw === 'string' ? raw.replace(/:\d+@lid$/, '@lid') : null

    // Logged either way, and at info: this is the one line that says whether WhatsApp will
    // hand over the pairing for a given number, and the contact rules stand or fall on it.
    log.info({ pn: jid, raw: raw ?? null, lid }, lid
      ? '[lid] ✔ Resolved phone number to LID'
      : '[lid] — WhatsApp returned no LID for this number')

    return lid
  } catch (err) {
    log.error({ err, pn: jid }, '[lid] ✖ LID lookup threw')
    return null
  }
}

/**
 * Takes this number out of a group.
 *
 * The one action here that cannot be undone from our side: WhatsApp requires a fresh invite from
 * a member to put the agent back, so nothing upstream may offer a re-join. Leaving itself needs
 * no admin rights — a member can always walk out.
 *
 * Returns whether WhatsApp accepted it, which is not the same as whether Messenger-BE thinks the
 * agent has left: the policy there is stamped before this command is dispatched, deliberately,
 * because an offline connector never receives it at all and a record that hides a departure is
 * worse than one that overstates it.
 */
export async function leaveGroup(jid: string): Promise<boolean> {
  if (!activeSocket) {
    log.warn({ jid }, '[group] ✖ Cannot leave — WhatsApp socket is not connected')
    return false
  }

  // Guarded rather than trusted. `groupLeave` on a non-group id is a malformed stanza sent to
  // WhatsApp's servers, and this address arrives over the wire from another service.
  if (!jid.endsWith('@g.us')) {
    log.warn({ jid }, '[group] ✖ Refusing to leave — not a group address')
    return false
  }

  try {
    await activeSocket.groupLeave(jid)
    log.info({ jid }, '[group] ✔ Left the group')
    return true
  } catch (err) {
    log.error({ err, jid }, '[group] ✖ groupLeave threw')
    return false
  }
}

export async function logout(): Promise<void> {
  if (activeSocket) {
    try { await activeSocket.logout() } catch { /* already disconnected */ }
    activeSocket = null
  }
  if (fs.existsSync(WA_SESSION_DIR)) {
    fs.rmSync(WA_SESSION_DIR, { recursive: true, force: true })
  }
}

// Local "Clear Session" button — a hard reset the user can trigger even when
// there's no live WhatsApp socket to call .logout() on (e.g. it never
// connected, or WhatsApp already dropped it). Just ends the socket if any and
// wipes the on-disk auth state, same end result as the manual
// `Remove-Item wa_session` step, without hitting the WhatsApp API.
export function resetLocalWaSession(): void {
  stopWhatsApp()
  if (fs.existsSync(WA_SESSION_DIR)) {
    fs.rmSync(WA_SESSION_DIR, { recursive: true, force: true })
  }
}

export function stopWhatsApp(): void {
  if (activeSocket) {
    try { activeSocket.end(undefined) } catch { /* ignore */ }
    activeSocket = null
  }
}
