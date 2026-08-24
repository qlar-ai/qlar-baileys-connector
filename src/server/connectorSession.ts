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
      async (payload: { to: string; text: string; quotedMessageId?: string; clientMessageId?: string }) => {
        if (!payload?.to || payload?.text == null) return
        try {
          const waMessageId = await this.wa?.sendMessage(payload.to, payload.text, payload.quotedMessageId)

          // Reporting the real id back is what lets Messenger-BE recognise a reaction that later
          // lands on this message. Best-effort: the message itself has already been delivered, so a
          // failure here costs the ability to answer a reaction, not the answer.
          if (payload.clientMessageId && waMessageId && this.sessionId) {
            try {
              await connection.invoke('MessageSent', this.sessionId, payload.clientMessageId, waMessageId)
            } catch (err) {
              this.log.warn({ err, waMessageId }, '[hub] MessageSent failed — reactions on this message cannot be traced')
            }
          }
        } catch (err) {
          this.log.error({ err, to: payload.to }, '[hub] send failed')
        }
      },
    )

    // Its own client method rather than a wider SendMessage signature, for the same reason
    // DeclareHosted is separate: SignalR matches by name and arity, and a connector that has
    // not been redeployed must keep working. Older connectors simply never receive this.
    connection.on(
      'SendReaction',
      async (payload: { to: string; emoji: string; targetMessageId: string }) => {
        if (!payload?.to || !payload?.targetMessageId) return
        try {
          await this.wa?.sendReaction(payload.to, payload.emoji ?? '', payload.targetMessageId)
        } catch (err) {
          this.log.error({ err, to: payload.to }, '[hub] send reaction failed')
        }
      },
    )

    /*
      Messenger-BE asking which LID a phone number answers to.

      A command down and a separate invoke back up, rather than a SignalR client result, because
      a connector that predates this simply never registers the handler — the server's push lands
      nowhere and the contact rules behave exactly as they did before. A client result would
      leave the server awaiting an answer that is never coming.
    */
    connection.on('ResolveLid', async (payload: { pn?: string }) => {
      const pn = payload?.pn
      const sessionId = this.sessionId

      if (!pn || !sessionId) {
        this.log.warn({ rawPayload: payload }, '[hub] ✖ ResolveLid payload missing "pn" — ignoring')
        return
      }

      this.log.info({ pn }, '[hub] ◀ ResolveLid command received from Messenger-BE')

      const lid = (await this.wa?.resolveLid(pn)) ?? null

      // Reported even when nothing was found, so the server can stop asking about a number
      // WhatsApp will not pair — silence here would have it retry on every list load forever.
      try {
        await connection.invoke('LidResolved', sessionId, pn, lid ?? '')
      } catch (err) {
        this.log.error({ err, pn }, '[hub] ✖ Failed to report the LID lookup result')
      }
    })

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
        // Re-declared on every reconnect, not just at startup. Messenger-BE drops the
        // session's in-memory status when the connection goes, so a transport blip would
        // otherwise leave it reporting this channel as self-hosted — and the CMS would
        // quietly stop showing the idle-revocation warning until the process restarted.
        await this.declareHosted()
        await this.announceWaState()
      } catch (err) {
        this.log.error({ err }, '[hub] re-register after reconnect failed')
      }
    })

    await connection.start()

    if (this.sessionId) {
      // Restored session — re-register straight away.
      await connection.invoke('Reconnect', this.sessionId)
      await this.declareHosted()
      await this.announceWaState()
      if (!this.waStarted) this.initWa()
    } else {
      // Fresh session — Pair with the one-time code.
      await this.pair()
    }
  }

  /**
   * Tell Messenger-BE this session lives on the hosted server, so it is eligible for the
   * idle sweep that revokes abandoned pairings.
   *
   * Only this class calls it — `hub.ts`, the single-session connector customers run on
   * their own machines, never does, which is what keeps self-hosted sessions out of the
   * sweep. Sent as its own call rather than an extra argument on Pair/Reconnect so older
   * connectors keep working: SignalR matches hub methods by name and arity, and widening
   * either signature would break every client that has not been redeployed.
   *
   * Failure is not fatal. The worst case is a hosted session that goes unswept until the
   * next reconnect re-declares it — far better than refusing to serve messages.
   */
  private async declareHosted(): Promise<void> {
    if (!this.sessionId) return

    try {
      await this.connection?.invoke('DeclareHosted', this.sessionId)
      this.log.info('[hub] declared as hosted connector session')
    } catch (err) {
      this.log.warn({ err }, '[hub] DeclareHosted failed — session will not be swept for idleness')
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
    await this.declareHosted()
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
              // A new field on an existing payload, which SignalR resolves by method name and
              // arity — a connector predating this simply omits it, and the server reads the
              // absence as "no second address known" rather than as a contradiction.
              fromAlt: msg.fromAlt ?? '',
              text: msg.text,
              messageId: msg.messageId,
              quotedMessageId: msg.quotedMessageId ?? '',
              quotedText: msg.quotedText ?? '',
              isGroup: msg.isGroup ?? false,
              groupName: msg.groupName ?? '',
              senderJid: msg.senderJid ?? '',
              senderName: msg.senderName ?? '',
              isAddressedToBot: msg.isAddressedToBot ?? true,
            })
            .catch((err) => this.log.error({ err }, '[hub] MessageInbound failed'))
        },
        onReaction: (reaction) => {
          conn
            ?.invoke('ReactionInbound', {
              sessionId,
              agentId: this.agentId,
              from: reaction.from,
              emoji: reaction.emoji,
              targetMessageId: reaction.targetMessageId,
              targetFromMe: reaction.targetFromMe,
              targetText: reaction.targetText ?? '',
              reactorJid: reaction.reactorJid,
              reactorName: reaction.reactorName ?? '',
              isGroup: reaction.isGroup ?? false,
              groupName: reaction.groupName ?? '',
              isFromSelf: reaction.isFromSelf ?? false,
            })
            .catch((err) => this.log.error({ err }, '[hub] ReactionInbound failed'))
        },
      })
      .catch((err) => {
        this.log.error({ err }, '[wa] startup error')
        this.waStarted = false
      })
  }

  /**
   * Retire the session for good: hand WhatsApp a real logout first, then stop.
   *
   * `stop()` alone only closes the socket, so wiping the state directory afterwards leaves
   * the device still listed under "Linked devices" on the user's phone — a slot burned on
   * a session nobody can reach, and one of only four. `logout()` invalidates it upstream
   * and removes the credentials, which is what makes the next pairing start from a QR scan
   * as though the account had never been linked.
   *
   * A failed logout is swallowed: an unreachable WhatsApp must not block teardown, and the
   * local state is wiped either way.
   */
  async revoke(): Promise<void> {
    try {
      await this.wa?.logout()
    } catch (err) {
      this.log.warn({ err }, '[wa] logout failed during revoke — tearing down anyway')
    }

    await this.stop()
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
