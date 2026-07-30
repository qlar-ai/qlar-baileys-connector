import * as path from 'path'
import * as signalR from '@microsoft/signalr'
import pino, { Logger } from 'pino'
import { WaSession } from './waSession'

export interface SessionMeta {
  sessionId: string
  agentId: string
  hubUrl: string
}

export interface ConnectorSessionHandlers {
  /** Called once Pair succeeds and the real sessionId/agentId are known. */
  onRegistered: (meta: SessionMeta) => void
  /** Called when the hub tells this session to log out. */
  onClosed: (sessionId: string) => void
}

/**
 * One tenant's connection: a single SignalR connection to Messenger-BE's
 * ConnectorHub plus a single Baileys WhatsApp session. Mirrors the single-session
 * `hub.ts` flow (Pair / Reconnect / QrGenerated / Connected / MessageInbound /
 * SendMessage), but scoped to an instance so the server can run many at once.
 *
 * The WhatsApp state directory is keyed by sessionId under `dataRoot`, so it is
 * only known after Pair returns (fresh sessions) or is passed in (restored ones).
 */
export class ConnectorSession {
  private connection: signalR.HubConnection | null = null
  private wa: WaSession | null = null
  private sessionId: string | null
  private agentId: string
  private waStarted = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly log: Logger

  constructor(
    private readonly hubUrl: string,
    private readonly dataRoot: string,
    private readonly opts: { code?: string; sessionId?: string; agentId?: string },
    private readonly handlers: ConnectorSessionHandlers,
  ) {
    this.sessionId = opts.sessionId ?? null
    this.agentId = opts.agentId ?? ''
    this.log = pino({ level: process.env.LOG_LEVEL ?? 'info' }).child({ session: opts.sessionId ?? 'pairing' })
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  private sessionDir(): string {
    if (!this.sessionId) throw new Error('sessionDir requested before sessionId is known')
    return path.join(this.dataRoot, this.sessionId)
  }

  async start(): Promise<void> {
    const connection = new signalR.HubConnectionBuilder()
      .withUrl(this.hubUrl)
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (ctx) => (ctx.elapsedMilliseconds < 60_000 ? 3000 : 10_000),
      })
      .configureLogging(signalR.LogLevel.Warning)
      .build()
    this.connection = connection

    connection.on(
      'SendMessage',
      async (payload: { to: string; text: string; quotedMessageId?: string }) => {
        if (!payload?.to || payload?.text == null) return
        try {
          await this.wa?.sendMessage(payload.to, payload.text, payload.quotedMessageId)
        } catch (err) {
          this.log.error({ err, to: payload.to }, '[hub] send failed')
        }
      },
    )

    connection.on('GenerateQr', () => {
      this.log.info('[hub] GenerateQr — restarting Baileys')
      this.wa?.stop()
      this.waStarted = false
      this.initWa()
    })

    connection.on('Logout', async () => {
      this.log.info('[hub] Logout')
      await this.wa?.logout()
      const id = this.sessionId ?? ''
      this.handlers.onClosed(id)
      await this.stop()
    })

    connection.onreconnected(async () => {
      if (!this.sessionId) return
      try {
        await connection.invoke('Reconnect', this.sessionId)
        await this.announceWaState()
      } catch (err) {
        this.log.error({ err }, '[hub] re-register after reconnect failed')
      }
    })

    await connection.start()

    if (this.sessionId) {
      // Restored session — re-register straight away.
      await connection.invoke('Reconnect', this.sessionId)
      await this.announceWaState()
      if (!this.waStarted) this.initWa()
    } else {
      // Fresh session — Pair with the one-time code.
      await this.pair()
    }
  }

  /**
   * Re-report the live WhatsApp link to Messenger-BE after (re)attaching to the hub.
   *
   * Messenger-BE keeps connector state in an in-memory registry, so every restart — i.e. every
   * deployment — wipes IsConnected and PhoneNumber. SignalR reconnects and `Reconnect` restores the
   * ConnectionId, but nothing restores those two fields: they are only ever set by `Connected`,
   * which this connector sends from Baileys' `connection.update`. When the WhatsApp socket itself
   * never dropped that event never fires again, so the server would keep reporting
   * `isConnected:false` until the next WhatsApp-level reconnect — days, potentially. Announcing the
   * state we already hold closes that window.
   */
  private async announceWaState(): Promise<void> {
    const phone = this.wa?.connectedPhoneNumber

    if (!this.sessionId || !phone) return

    try {
      await this.connection?.invoke('Connected', this.sessionId, phone)
      this.log.info({ phone }, '[hub] re-announced WhatsApp link after hub reconnect')
    } catch (err) {
      this.log.error({ err }, '[hub] re-announce of WhatsApp link failed')
    }
  }

  private async pair(): Promise<void> {
    if (!this.connection) throw new Error('connection not initialised')
    if (!this.opts.code) throw new Error('no pairing code and no sessionId')

    const result = await this.connection.invoke<{ sessionId: string; agentId: string }>('Pair', this.opts.code)
    this.sessionId = result.sessionId
    this.agentId = result.agentId
    this.log.info({ sessionId: this.sessionId }, '[hub] paired')
    this.handlers.onRegistered({ sessionId: this.sessionId, agentId: this.agentId, hubUrl: this.hubUrl })
    this.initWa()
  }

  private initWa(): void {
    if (this.waStarted || !this.sessionId) return
    this.waStarted = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    const sessionId = this.sessionId
    const conn = this.connection
    this.wa = new WaSession(this.sessionDir(), sessionId)

    this.wa
      .start({
        onQr: (qr) => {
          conn?.invoke('QrGenerated', sessionId, qr).catch((err) => this.log.error({ err }, '[hub] QrGenerated failed'))
        },
        onConnected: (phone) => {
          this.log.info({ phone }, '[wa] connected')
          conn?.invoke('Connected', sessionId, phone).catch((err) => this.log.error({ err }, '[hub] Connected failed'))
        },
        onDisconnected: (reason, shouldReconnect) => {
          this.waStarted = false
          conn?.invoke('Disconnected', sessionId, reason).catch(() => { /* hub may be offline */ })
          if (shouldReconnect) {
            this.reconnectTimer = setTimeout(() => this.initWa(), 5000)
            return
          }
          // WhatsApp logged this device out (401 loggedOut). These creds are dead —
          // reconnecting only re-triggers the logout. Tear the session down and let
          // the manager wipe it, otherwise restore() resurrects it on every restart
          // and the account piles up dead linked-devices until WhatsApp 401s them all.
          this.log.warn('[wa] logged out (401) — removing and wiping session')
          this.handlers.onClosed(sessionId)
          void this.stop()
        },
        onMessage: (msg) => {
          conn
            ?.invoke('MessageInbound', {
              sessionId,
              agentId: this.agentId,
              from: msg.from,
              text: msg.text,
              messageId: msg.messageId,
              quotedMessageId: msg.quotedMessageId ?? '',
              quotedText: msg.quotedText ?? '',
            })
            .catch((err) => this.log.error({ err }, '[hub] MessageInbound failed'))
        },
      })
      .catch((err) => {
        this.log.error({ err }, '[wa] startup error')
        this.waStarted = false
      })
  }

  async stop(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.wa?.stop()
    this.wa = null
    if (this.connection) {
      try {
        await this.connection.stop()
      } catch { /* ignore */ }
      this.connection = null
    }
  }
}
