import * as path from 'path'
import * as signalR from '@microsoft/signalr'
import pino, { Logger } from 'pino'
import { InboundImageContext, WaSession } from './waSession'

/**
 * A file name whose extension matches the picture, because Dialog-BE reads the MIME type back off
 * the stored file's extension when it builds the model's content part — a picture stored under the
 * wrong one arrives as an unreadable attachment rather than as something to look at.
 *
 * Falls back to `.jpg`, which is what a WhatsApp photo almost always is.
 */
function imageFileName(mimeType: string): string {
  const type = (mimeType || '').split(';')[0].trim().toLowerCase()

  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/heic': 'heic',
    'image/heif': 'heif',
  }

  return `image.${extensions[type] ?? 'jpg'}`
}

/**
 * A file name whose extension matches the audio, because the transcription provider infers the
 * container from it and rejects a mismatch outright — a WhatsApp voice note named `.webm` fails
 * with an HTTP 400 rather than being sniffed and accepted.
 *
 * Falls back to `.ogg`, which is what WhatsApp voice notes actually are. A guess is unavoidable
 * when the mime type is missing, and that is the one worth making.
 */
function voiceNoteFileName(mimeType: string): string {
  const type = (mimeType || '').split(';')[0].trim().toLowerCase()

  const extensions: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/opus': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'm4a',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/amr': 'amr',
  }

  return `voice-note.${extensions[type] ?? 'ogg'}`
}

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
      A picture, to be delivered as a WhatsApp image message.

      Its own client method for the same reason SendReaction is, and the server only pushes it after
      DeclareImageSupport below — a connector without this handler would accept the push and drop it.

      The WhatsApp id is reported back the way a text message's is, so a reaction landing on a
      picture can still be traced to the answer it belonged to.
    */
    connection.on(
      'SendImageMessage',
      async (payload: { to: string; imageUrl: string; caption?: string; clientMessageId?: string }) => {
        if (!payload?.to || !payload?.imageUrl) return

        try {
          const waMessageId = await this.wa?.sendImageMessage(
            payload.to,
            payload.imageUrl,
            payload.caption ?? '',
          )

          if (waMessageId && payload.clientMessageId) {
            await connection.invoke('MessageSent', this.sessionId, payload.clientMessageId, waMessageId)
          }
        } catch (err) {
          this.log.error({ err, to: payload.to, imageUrl: payload.imageUrl }, '[hub] send picture failed')
        }
      },
    )

    /*
      A spoken answer, to be delivered as a WhatsApp voice note.

      Its own client method for the same reason SendReaction is: a connector that has not been
      redeployed never registers this handler, and the push lands nowhere. Which is why the server
      only sends it after DeclareVoiceSupport — see declareVoiceSupport below.

      Nothing is reported back. The written answer has already been delivered by the time this
      arrives, so a failure here costs the spoken copy of something the user already has, and there
      is no id upstream needs: a reaction on a voice note is not something the agent can answer.
    */
    connection.on(
      'SendAudioMessage',
      async (payload: { to: string; audioBase64: string; seconds?: number; mimeType?: string }) => {
        if (!payload?.to || !payload?.audioBase64) return
        try {
          await this.wa?.sendAudioMessage(
            payload.to,
            payload.audioBase64,
            payload.seconds ?? 0,
            payload.mimeType ?? 'audio/ogg; codecs=opus',
          )
        } catch (err) {
          this.log.error({ err, to: payload.to }, '[hub] send voice note failed')
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

    /*
      Messenger-BE telling us to walk out of a group an operator rejected.

      No answer goes back up. The server has already recorded the departure — it has to, because
      a connector that is offline never receives this at all — so an invoke here would only be
      confirming something already written. A failure is logged and left; the operator sees the
      agent is still in the group and can ask again.
    */
    connection.on('LeaveGroup', async (payload: { jid?: string }) => {
      const jid = payload?.jid

      if (!jid) {
        this.log.warn({ rawPayload: payload }, '[hub] ✖ LeaveGroup payload missing "jid" — ignoring')
        return
      }

      this.log.info({ jid }, '[hub] ◀ LeaveGroup command received from Messenger-BE')
      await this.wa?.leaveGroup(jid)
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
        await this.declareVoiceSupport()
        await this.declareImageSupport()
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
      await this.declareVoiceSupport()
      await this.declareImageSupport()
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
   * Tell Messenger-BE this build understands voice notes, so it may push spoken answers here.
   *
   * It has to be declared. SignalR resolves client methods by name, so a `SendAudioMessage` push
   * to a connector with no handler for it is accepted and then dropped in complete silence — the
   * server would record a voice note it never sent, and the user would be left waiting for it.
   *
   * Re-declared on every reconnect for the same reason as `declareHosted`: the server holds this in
   * memory, so a transport blip or a deployment loses it. Losing it is safe — the channel falls
   * back to text-only answers — but it stays lost until something says otherwise.
   *
   * Failure is not fatal. The worst case is a channel that answers in writing only, which is what
   * every channel did before this existed.
   */
  private async declareVoiceSupport(): Promise<void> {
    if (!this.sessionId) return

    try {
      await this.connection?.invoke('DeclareVoiceSupport', this.sessionId)
      this.log.info('[hub] declared voice-note support')
    } catch (err) {
      // Expected, and harmless, against a Messenger-BE that predates voice notes: the hub method
      // does not exist there, so this throws and the channel simply stays text-only.
      this.log.warn({ err }, '[hub] DeclareVoiceSupport failed — answers will be text only')
    }
  }

  /**
   * Tell Messenger-BE this build can send a picture, so it may push one here.
   *
   * Declared for the same reason voice support is: SignalR resolves client methods by name, so a
   * `SendImageMessage` push to a connector with no handler for it is accepted and then dropped in
   * silence. Without this the server keeps doing what it always did — sending the picture's URL as
   * text, which at least arrives.
   */
  private async declareImageSupport(): Promise<void> {
    if (!this.sessionId) return

    try {
      await this.connection?.invoke('DeclareImageSupport', this.sessionId)
      this.log.info('[hub] declared picture support')
    } catch (err) {
      // Expected, and harmless, against a Messenger-BE that predates outbound pictures: the hub
      // method does not exist there, so this throws and pictures stay links.
      this.log.warn({ err }, '[hub] DeclareImageSupport failed — pictures will be sent as links')
    }
  }

  /**
   * Uploads a voice note to Messenger-BE and returns the words it came back with.
   *
   * Over HTTP rather than the hub, because Messenger-BE's SignalR runs with the default 32 KB
   * receive limit and a voice note of any length exceeds it once base64 has added its third.
   *
   * The reply also decides whether transcription should have happened at all — `enabled: false`
   * means this channel is not set up for voice notes, or the note was too long to pay for. Null
   * either way: the caller drops the message, which is what an untranscribed voice note has always
   * done.
   */
  /**
   * Uploads a picture to Messenger-BE and returns the URL it can be read from.
   *
   * Over HTTP rather than the hub, for the same reason the voice note is: Messenger-BE's SignalR
   * runs with a 32 KB receive limit that a photo clears several times over, and bytes on that
   * channel would compete with every control message the server steers this connector with.
   *
   * The reply also decides whether the picture should have been processed at all — `enabled: false`
   * means this deployment has pictures switched off, the picture was too large, or it was
   * captionless chatter in a room that never addressed the agent. Null in every such case, and the
   * caller then submits the message without it.
   */
  private async hostImage(
    image: Buffer,
    mimeType: string,
    messageId: string,
    context: InboundImageContext,
  ): Promise<string | null> {
    if (!this.sessionId) return null

    try {
      const form = new FormData()

      form.append('file', new Blob([new Uint8Array(image)], { type: mimeType }), imageFileName(mimeType))
      form.append('messageId', messageId)
      // The sender, so Dialog-BE can bill the guardrail check it runs on this picture to the
      // conversation it belongs to.
      form.append('from', context.from)
      // What the endpoint's cost guard reads. Only this side knows whether the room addressed us.
      form.append('isGroup', String(context.isGroup))
      form.append('isAddressedToBot', String(context.isAddressedToBot))
      form.append('hasText', String(context.hasText))

      const response = await fetch(`${this.apiBaseUrl()}/api/baileys/${this.sessionId}/inbound-image`, {
        method: 'POST',
        body: form,
      })

      if (!response.ok) {
        this.log.warn(
          { status: response.status, messageId },
          '[hub] ✖ picture upload refused — message forwarded without it',
        )

        return null
      }

      const result = (await response.json()) as { enabled?: boolean; url?: string; reason?: string }

      if (!result.enabled) {
        this.log.info(
          { messageId, reason: result.reason ?? 'unknown' },
          '[hub] picture not hosted — the channel did not want it',
        )

        return null
      }

      const url = (result.url ?? '').trim()

      if (!url) {
        this.log.warn({ messageId }, '[hub] ✖ picture hosted to nothing — message forwarded without it')
        return null
      }

      this.log.info({ messageId, url }, '[hub] ✔ picture hosted')

      return url
    } catch (err) {
      this.log.error({ err, messageId }, '[hub] ✖ picture upload failed — message forwarded without it')

      return null
    }
  }

  /**
   * Uploads a document to Messenger-BE and returns the URL it can be read from.
   *
   * Its own method rather than a flag on `hostImage`, because the two are refused for different
   * reasons — a picture by format and size, a document by whether its text can be extracted at all
   * — and the endpoint that answers each is a different one.
   */
  private async hostDocument(
    document: Buffer,
    mimeType: string,
    fileName: string,
    messageId: string,
    context: InboundImageContext,
  ): Promise<string | null> {
    if (!this.sessionId) return null

    try {
      const form = new FormData()

      form.append('file', new Blob([new Uint8Array(document)], { type: mimeType }), fileName || 'document.pdf')
      form.append('messageId', messageId)
      // The sender's own name for the file, which is both what decides how it is processed (the
      // extension) and what the agent will call it when it answers.
      form.append('fileName', fileName)
      form.append('from', context.from)
      form.append('isGroup', String(context.isGroup))
      form.append('isAddressedToBot', String(context.isAddressedToBot))
      form.append('hasText', String(context.hasText))

      const response = await fetch(`${this.apiBaseUrl()}/api/baileys/${this.sessionId}/inbound-document`, {
        method: 'POST',
        body: form,
      })

      if (!response.ok) {
        this.log.warn(
          { status: response.status, messageId, fileName },
          '[hub] ✖ document upload refused — message forwarded without it',
        )

        return null
      }

      const result = (await response.json()) as { enabled?: boolean; url?: string; reason?: string }

      if (!result.enabled) {
        this.log.info(
          { messageId, fileName, reason: result.reason ?? 'unknown' },
          '[hub] document not hosted — the channel did not want it',
        )

        return null
      }

      const url = (result.url ?? '').trim()

      if (!url) {
        // Includes the honest failure: a PDF whose text could not be extracted is refused upstream,
        // and there is nothing for the agent to read in it.
        this.log.warn(
          { messageId, fileName },
          '[hub] ✖ document hosted to nothing — message forwarded without it',
        )

        return null
      }

      this.log.info({ messageId, fileName, url }, '[hub] ✔ document hosted')

      return url
    } catch (err) {
      this.log.error(
        { err, messageId, fileName },
        '[hub] ✖ document upload failed — message forwarded without it',
      )

      return null
    }
  }

  private async transcribeVoiceNote(
    audio: Buffer,
    mimeType: string,
    seconds: number,
    messageId: string,
  ): Promise<string | null> {
    if (!this.sessionId) return null

    try {
      const form = new FormData()

      // The extension is what the transcription provider infers the container from, and it rejects
      // a mismatch outright — so it is derived from what WhatsApp actually said the audio is,
      // never assumed.
      form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), voiceNoteFileName(mimeType))
      form.append('messageId', messageId)
      form.append('seconds', String(seconds))

      const response = await fetch(`${this.apiBaseUrl()}/api/baileys/${this.sessionId}/inbound-audio`, {
        method: 'POST',
        body: form,
      })

      if (!response.ok) {
        this.log.warn(
          { status: response.status, messageId, seconds },
          '[hub] ✖ voice note upload refused — message dropped',
        )

        return null
      }

      const result = (await response.json()) as { enabled?: boolean; text?: string; reason?: string }

      if (!result.enabled) {
        this.log.info(
          { messageId, seconds, reason: result.reason ?? 'unknown' },
          '[hub] voice note not transcribed — the channel is not set up for it',
        )

        return null
      }

      const text = (result.text ?? '').trim()

      if (!text) {
        this.log.info({ messageId, seconds }, '[hub] voice note transcribed to nothing — message dropped')
        return null
      }

      this.log.info({ messageId, seconds, textLength: text.length }, '[hub] ✔ voice note transcribed')

      return text
    } catch (err) {
      this.log.error({ err, messageId, seconds }, '[hub] ✖ voice note transcription failed')

      return null
    }
  }

  /**
   * The HTTP root of the Messenger-BE that serves this session's hub.
   *
   * Derived from the hub URL rather than configured separately, so there is exactly one address to
   * point at an environment — and so a connector aimed at a developer's own machine, a direct App
   * Service URL, or an APIM front door all reach the matching API without a second setting to keep
   * in step.
   */
  private apiBaseUrl(): string {
    return this.hubUrl.replace(/\/hubs\/connector\/?$/i, '')
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
    await this.declareVoiceSupport()
    await this.declareImageSupport()
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
              mentionsOthers: msg.mentionsOthers ?? false,
              quotedFromAgent: msg.quotedFromAgent ?? false,
              // The text above is already the transcript. These two only say where it came from,
              // which is what makes the answer eligible to be spoken back.
              isVoiceNote: msg.isVoiceNote ?? false,
              voiceSeconds: msg.voiceSeconds ?? 0,
              // Already hosted, so this is a list of URLs rather than the pictures themselves. A
              // server predating the field ignores it, and the message reads as text-only — which
              // for a captioned picture is exactly what it used to be.
              imageUrls: msg.imageUrls ?? [],
              documents: msg.documents ?? [],
              unreadableAttachment: msg.unreadableAttachment ?? '',
            })
            .catch((err) => this.log.error({ err }, '[hub] MessageInbound failed'))
        },
        transcribeVoiceNote: (audio, mimeType, seconds, messageId) =>
          this.transcribeVoiceNote(audio, mimeType, seconds, messageId),
        hostImage: (image, mimeType, messageId, context) =>
          this.hostImage(image, mimeType, messageId, context),
        hostDocument: (document, mimeType, fileName, messageId, context) =>
          this.hostDocument(document, mimeType, fileName, messageId, context),
        onReaction: (reaction) => {
          conn
            ?.invoke('ReactionInbound', {
              sessionId,
              agentId: this.agentId,
              from: reaction.from,
              fromAlt: reaction.fromAlt ?? '',
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
