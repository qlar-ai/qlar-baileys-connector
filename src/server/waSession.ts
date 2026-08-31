import makeWASocket, {
  areJidsSameUser,
  Browsers,
  DisconnectReason,
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

  /** The text of a message, whichever content type happens to carry it. */
  private static textOf(message: proto.IMessage | null | undefined): string {
    if (!message) return ''

    return (
      message.conversation ??
      message.extendedTextMessage?.text ??
      message.imageMessage?.caption ??
      message.videoMessage?.caption ??
      ''
    )
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

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      for (const msg of messages) this.cache(msg.key.id, msg.message)
      if (type !== 'notify') return

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue

        const from = msg.key.remoteJid ?? ''

        // Baileys fills this from the stanza's addressing context, so for a LID-migrated contact
        // the phone number is right here — see Utils/decode-wa-message.
        const fromAlt = msg.key.remoteJidAlt ?? ''
        const text =
          msg.message.conversation ??
          msg.message.extendedTextMessage?.text ??
          msg.message.imageMessage?.caption ??
          ''

        if (!text || !from) continue

        // Kept before the callback so the reply that follows can quote this exact message.
        this.cacheQuotable(msg)

        const contextInfo = WaSession.contextInfoOf(msg.message)
        const isGroup = isJidGroup(from) ?? false

        this.log.info(
          { from, fromAlt, messageId: msg.key.id, isGroup, textPreview: text.slice(0, 120) },
          '[in] ← inbound message forwarded to hub',
        )

        cb.onMessage({
          from,
          fromAlt,
          text,
          messageId: msg.key.id ?? '',
          ...WaSession.readQuoteContext(contextInfo),
          isGroup,
          // In a group `from` is the group itself, so the individual comes off the key.
          senderJid: isGroup ? (msg.key.participant ?? '') : from,
          senderName: msg.pushName ?? '',
          groupName: isGroup ? this.groupSubject(from) : '',
          // Individual chats are always addressed to the bot; groups have to earn it. The other
          // two are group-only by nature — in a one-to-one chat there is nobody else to aim at.
          ...(isGroup
            ? this.readAddressing(contextInfo)
            : { isAddressedToBot: true, mentionsOthers: false, quotedFromAgent: false }),
        })
      }
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

    const result = await this.socket.sendMessage(jid, { text }, quoted ? { quoted } : undefined)
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
