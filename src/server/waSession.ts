import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  WASocket,
} from '@whiskeysockets/baileys'
import * as fs from 'fs'
import * as path from 'path'
import pino, { Logger } from 'pino'

export interface InboundMessage {
  from: string
  text: string
  messageId: string
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
  private readonly waDir: string
  private readonly messageStore = new Map<string, proto.IMessage>()
  private readonly log: Logger
  private readonly baileysLogger: Logger

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
        this.log.info({ phoneNumber }, '[wa] connection open')
        cb.onConnected(phoneNumber)
      }

      if (connection === 'close') {
        this.socket = null
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
        cb.onMessage({ from, text, messageId: msg.key.id ?? '' })
      }
    })
  }

  async sendMessage(to: string, text: string): Promise<void> {
    if (!this.socket) throw new Error('WhatsApp socket is not connected')
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
    const result = await this.socket.sendMessage(jid, { text })
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
