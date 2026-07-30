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
}

export interface WaCallbacks {
  onQr: (qrBase64: string) => void
  onConnected: (phoneNumber: string) => void
  onDisconnected: (reason: string, shouldReconnect: boolean) => void
  onMessage: (msg: InboundMessage) => void
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
  private groupSubject(jid: string): string {
    const cached = this.groupSubjects.get(jid)

    if (cached !== undefined) return cached

    // Reserve the key so concurrent messages don't each fire their own lookup.
    this.groupSubjects.set(jid, '')

    void this.socket
      ?.groupMetadata(jid)
      .then((meta) => this.groupSubjects.set(jid, meta?.subject ?? ''))
      .catch((err) => this.log.warn({ err, jid }, '[wa] group metadata lookup failed'))

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
  private isAddressedToBot(contextInfo: proto.IContextInfo | null | undefined): boolean {
    const me = [this.socket?.user?.id, this.socket?.user?.lid].filter(Boolean) as string[]

    if (me.length === 0) return false

    const mentioned = contextInfo?.mentionedJid ?? []

    if (mentioned.some((jid) => me.some((mine) => areJidsSameUser(jid, mine)))) return true

    const quotedAuthor = contextInfo?.participant

    return !!quotedAuthor && me.some((mine) => areJidsSameUser(quotedAuthor, mine))
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

        cb.onMessage({
          from,
          text,
          messageId: msg.key.id ?? '',
          ...WaSession.readQuoteContext(contextInfo),
          isGroup,
          // In a group `from` is the group itself, so the individual comes off the key.
          senderJid: isGroup ? (msg.key.participant ?? '') : from,
          senderName: msg.pushName ?? '',
          groupName: isGroup ? this.groupSubject(from) : '',
          // Individual chats are always addressed to the bot; groups have to earn it.
          isAddressedToBot: isGroup ? this.isAddressedToBot(contextInfo) : true,
        })
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
  async sendMessage(to: string, text: string, quotedMessageId?: string): Promise<void> {
    if (!this.socket) throw new Error('WhatsApp socket is not connected')

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
    const quoted = quotedMessageId ? this.quotableStore.get(quotedMessageId) : undefined

    if (quotedMessageId && !quoted) {
      this.log.warn({ quotedMessageId }, '[wa] quoted message not in cache — sending unquoted')
    }

    const result = await this.socket.sendMessage(jid, { text }, quoted ? { quoted } : undefined)
    this.cache(result?.key?.id, result?.message)
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
