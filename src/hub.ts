import { EventEmitter } from 'events'
import * as signalR from '@microsoft/signalr'
import pino from 'pino'
import { loadSession, saveSession, clearSession, LocalSession } from './session'
import { startWhatsApp, sendMessage, sendAudioMessage, logout, stopWhatsApp, resolveLid, leaveGroup } from './whatsapp'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

let localSession: LocalSession | null = null
let waStarted = false
// The number WhatsApp is currently linked to, or null when the socket is not open. Kept so the
// link can be re-reported to Messenger-BE without waiting on another Baileys connection event.
let connectedPhoneNumber: string | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

// Drives the GUI's green/red indicator and inline error banner. 'connected'
// tracks actual WhatsApp pairing/connection (Baileys reporting a phone
// number), not just the SignalR transport to Messenger-BE — the hub can be
// up while pairing itself failed or hasn't happened yet.
export type ConnectorStatus = 'connected' | 'disconnected'
export const hubEvents = new EventEmitter()

let currentStatus: ConnectorStatus = 'disconnected'

function setStatus(status: ConnectorStatus): void {
  currentStatus = status
  hubEvents.emit('status', status)
}

export function getStatus(): ConnectorStatus {
  return currentStatus
}

export function connectToHub(hubUrl: string, pairingCode?: string): void {
  const connection = new signalR.HubConnectionBuilder()
    .withUrl(hubUrl)
    .withAutomaticReconnect({
      nextRetryDelayInMilliseconds: (retryContext) => {
        if (retryContext.elapsedMilliseconds < 60_000) return 3000
        return 10_000
      },
    })
    .configureLogging(signalR.LogLevel.Warning)
    .build()

  connection.onreconnecting(() => {
    logger.info('[hub] Reconnecting to Messenger-BE…')
    setStatus('disconnected')
  })

  connection.onreconnected(async () => {
    logger.info('[hub] Reconnected — re-registering session')
    await reconnect(connection)
  })

  connection.onclose(() => {
    logger.warn('[hub] Connection closed — automatic reconnect gave up')
    setStatus('disconnected')
  })

  connection.on('SendMessage', async (payload: { to: string; text: string; quotedMessageId?: string }) => {
    // Raw payload exactly as it arrived over SignalR from Messenger-BE.
    // If `to`/`text` are undefined here, the server↔connector property casing
    // is mismatched (server sends a single { to, text } object).
    logger.info(
      { rawPayload: payload, to: payload?.to, textLength: payload?.text?.length },
      '[hub] ◀ SendMessage command received from Messenger-BE',
    )

    if (!payload?.to || payload?.text == null) {
      logger.error(
        { rawPayload: payload },
        '[hub] ✖ SendMessage payload missing "to"/"text" — aborting before Baileys',
      )
      return
    }

    try {
      await sendMessage(payload.to, payload.text, payload.quotedMessageId)
      logger.info({ to: payload.to }, '[hub] ✔ sendMessage() completed without throwing')
    } catch (err) {
      logger.error({ err, to: payload.to }, '[hub] ✖ Send failed')
    }
  })

  /*
    Messenger-BE asking which LID a phone number answers to.

    A command down and a separate invoke back up, rather than a SignalR client result, because
    a connector that predates this simply never registers the handler — the server's push
    lands nowhere and the contact rules behave exactly as they did before. A client result
    would leave the server awaiting an answer that is never coming.
  */
  connection.on('ResolveLid', async (payload: { pn?: string }) => {
    const pn = payload?.pn

    if (!pn || !localSession) {
      logger.warn({ rawPayload: payload }, '[hub] ✖ ResolveLid payload missing "pn" — ignoring')
      return
    }

    logger.info({ pn }, '[hub] ◀ ResolveLid command received from Messenger-BE')

    const lid = await resolveLid(pn)

    // Reported even when nothing was found, so the server can stop asking about a number
    // WhatsApp will not pair — silence here would have it retry on every list load forever.
    try {
      await connection.invoke('LidResolved', localSession.sessionId, pn, lid ?? '')
    } catch (err) {
      logger.error({ err, pn }, '[hub] ✖ Failed to report the LID lookup result')
    }
  })

  /*
    Messenger-BE telling us to walk out of a group an operator rejected.

    No answer goes back up. The server has already recorded the departure — it has to, because a
    connector that is offline never receives this at all — so an invoke here would only confirm
    something already written. A failure is logged and left; the operator sees the agent is still
    in the group and can ask again.
  */
  connection.on('LeaveGroup', async (payload: { jid?: string }) => {
    const jid = payload?.jid

    if (!jid) {
      logger.warn({ rawPayload: payload }, '[hub] ✖ LeaveGroup payload missing "jid" — ignoring')
      return
    }

    logger.info({ jid }, '[hub] ◀ LeaveGroup command received from Messenger-BE')
    await leaveGroup(jid)
  })

  /*
    A spoken answer, to be delivered as a WhatsApp voice note.

    Its own client method for the same reason SendReaction is: a connector that has not been
    redeployed never registers this handler, and the push lands nowhere. Which is why the server
    only sends it after DeclareVoiceSupport.

    Nothing goes back up. The written answer has already been delivered by the time this arrives,
    so a failure costs the spoken copy of something the user already has, and there is no id
    upstream needs — a reaction on a voice note is not something the agent can answer.
  */
  connection.on(
    'SendAudioMessage',
    async (payload: { to: string; audioBase64: string; seconds?: number; mimeType?: string }) => {
      if (!payload?.to || !payload?.audioBase64) return

      logger.info({ to: payload.to, seconds: payload.seconds ?? 0 }, '[hub] ◀ SendAudioMessage received')

      try {
        await sendAudioMessage(
          payload.to,
          payload.audioBase64,
          payload.seconds ?? 0,
          payload.mimeType ?? 'audio/ogg; codecs=opus',
        )
      } catch (err) {
        logger.error({ err, to: payload.to }, '[hub] ✖ Failed to send the voice note')
      }
    },
  )

  connection.on('GenerateQr', () => {
    logger.info('[hub] GenerateQr command received — restarting Baileys')
    stopWhatsApp()
    waStarted = false
    if (localSession) initWhatsApp(connection, localSession.sessionId)
  })

  connection.on('Logout', async () => {
    logger.info('[hub] Logout command received')
    await logout()
    clearSession()
    localSession = null
    waStarted = false
    hubEvents.emit('sessionCleared')
  })

  connection.start().then(async () => {
    logger.info('[hub] Connected to Messenger-BE at %s', hubUrl)

    if (pairingCode) {
      await pair(connection, hubUrl, pairingCode)
    } else {
      await reconnect(connection)
    }
  }).catch((err) => {
    logger.error({ err }, '[hub] Failed to connect to Messenger-BE')
    setStatus('disconnected')
    hubEvents.emit('error', 'Gagal konek ke Messenger-BE — cek koneksi internet atau hub URL.')
  })
}

async function pair(
  connection: signalR.HubConnection,
  hubUrl: string,
  code: string,
): Promise<void> {
  logger.info('[hub] Pairing with code %s', code)
  try {
    const result = await connection.invoke<{ sessionId: string; agentId: string }>('Pair', code)
    localSession = { sessionId: result.sessionId, agentId: result.agentId, hubUrl }
    saveSession(localSession)
    logger.info('[hub] Paired — SessionId: %s, AgentId: %s', result.sessionId, result.agentId)
    await declareVoiceSupport(connection, result.sessionId)
    initWhatsApp(connection, result.sessionId)
  } catch (err) {
    logger.error({ err }, '[hub] Pairing failed — check the code or try a fresh code from CMS-Web')
    hubEvents.emit('error', 'Pairing gagal — pairing code salah atau sudah kedaluwarsa.')
  }
}

async function reconnect(connection: signalR.HubConnection): Promise<void> {
  const session = loadSession()
  if (!session) {
    logger.error('[hub] No session.json found — need a pairing code first')
    hubEvents.emit('error', 'Belum ada session tersimpan — masukkan pairing code dulu.')
    return
  }
  localSession = session
  logger.info('[hub] Reconnecting session — SessionId: %s', session.sessionId)
  try {
    await connection.invoke('Reconnect', session.sessionId)
    // Re-declared on every reconnect, not just at startup: Messenger-BE holds this in memory, so a
    // transport blip or a deployment loses it and the channel silently drops back to text-only.
    await declareVoiceSupport(connection, session.sessionId)
    await announceWaState(connection)
    if (!waStarted) initWhatsApp(connection, session.sessionId)
  } catch (err) {
    logger.error({ err }, '[hub] Reconnect failed')
    hubEvents.emit('error', 'Reconnect ke Messenger-BE gagal.')
  }
}

/**
 * Tell Messenger-BE this build understands voice notes, so it may push spoken answers here.
 *
 * It has to be declared. SignalR resolves client methods by name, so a `SendAudioMessage` push to a
 * connector with no handler for it is accepted and then dropped in complete silence — the server
 * would record a voice note it never sent, and the user would be left waiting for it.
 *
 * Unlike `DeclareHosted`, which this self-hosted connector deliberately never sends, this one is
 * sent from here too: voice notes are not a hosted-only feature, and "is this the hosted server"
 * answers a different question from "does this build know about audio".
 *
 * Failure is not fatal, and is expected against a Messenger-BE that predates voice notes — the hub
 * method does not exist there, so the invoke throws and the channel stays text-only, which is what
 * every channel did before this existed.
 */
async function declareVoiceSupport(connection: signalR.HubConnection, sessionId: string): Promise<void> {
  try {
    await connection.invoke('DeclareVoiceSupport', sessionId)
    logger.info('[hub] Declared voice-note support')
  } catch (err) {
    logger.warn({ err }, '[hub] DeclareVoiceSupport failed — answers will be text only')
  }
}

/**
 * Uploads a voice note to Messenger-BE and returns the words it came back with.
 *
 * Over HTTP rather than the hub, because Messenger-BE's SignalR runs with the default 32 KB receive
 * limit and a voice note of any length exceeds it once base64 has added its third.
 *
 * The reply also decides whether transcription should have happened at all — `enabled: false` means
 * this channel is not set up for voice notes, or the note was too long to pay for. Null either way:
 * the caller drops the message, which is what an untranscribed voice note has always done.
 */
async function transcribeVoiceNote(
  sessionId: string,
  audio: Buffer,
  mimeType: string,
  seconds: number,
  messageId: string,
): Promise<string | null> {
  const hubUrl = localSession?.hubUrl

  if (!hubUrl) {
    logger.warn({ messageId }, '[hub] ✖ no hub URL known — voice note dropped')
    return null
  }

  // Derived from the hub URL rather than configured separately, so there is exactly one address to
  // point at an environment and no second setting to keep in step.
  const apiBaseUrl = hubUrl.replace(/\/hubs\/connector\/?$/i, '')

  try {
    const form = new FormData()

    // The extension is what the transcription provider infers the container from, and it rejects a
    // mismatch outright — so it is derived from what WhatsApp said the audio is, never assumed.
    form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), voiceNoteFileName(mimeType))
    form.append('messageId', messageId)
    form.append('seconds', String(seconds))

    const response = await fetch(`${apiBaseUrl}/api/baileys/${sessionId}/inbound-audio`, {
      method: 'POST',
      body: form,
    })

    if (!response.ok) {
      logger.warn(
        { status: response.status, messageId, seconds },
        '[hub] ✖ Voice note upload refused — message dropped',
      )

      return null
    }

    const result = (await response.json()) as { enabled?: boolean; text?: string; reason?: string }

    if (!result.enabled) {
      logger.info(
        { messageId, seconds, reason: result.reason ?? 'unknown' },
        '[hub] Voice note not transcribed — the channel is not set up for it',
      )

      return null
    }

    const text = (result.text ?? '').trim()

    if (!text) {
      logger.info({ messageId, seconds }, '[hub] Voice note transcribed to nothing — message dropped')
      return null
    }

    logger.info({ messageId, seconds, textLength: text.length }, '[hub] ✔ Voice note transcribed')

    return text
  } catch (err) {
    logger.error({ err, messageId, seconds }, '[hub] ✖ Voice note transcription failed')

    return null
  }
}

/**
 * A file name whose extension matches the audio, because the transcription provider infers the
 * container from it and rejects a mismatch outright — a WhatsApp voice note named `.webm` fails
 * with an HTTP 400 rather than being sniffed and accepted.
 *
 * Falls back to `.ogg`, which is what WhatsApp voice notes actually are. A guess is unavoidable when
 * the mime type is missing, and that is the one worth making.
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

/**
 * Re-report the live WhatsApp link to Messenger-BE after (re)attaching to the hub.
 *
 * Messenger-BE holds connector state in an in-memory registry, so every restart — i.e. every
 * deployment — wipes IsConnected and PhoneNumber. `Reconnect` restores the ConnectionId but not
 * those two fields: they are only ever set by `Connected`, which is sent from Baileys'
 * connection-open event. If the WhatsApp socket itself never dropped, that event never fires
 * again and the server would keep reporting the channel as offline indefinitely.
 */
async function announceWaState(connection: signalR.HubConnection): Promise<void> {
  if (!localSession || !connectedPhoneNumber) return

  try {
    await connection.invoke('Connected', localSession.sessionId, connectedPhoneNumber)
    setStatus('connected')
    logger.info('[hub] Re-announced WhatsApp link (+%s) after hub reconnect', connectedPhoneNumber)
  } catch (err) {
    logger.error({ err }, '[hub] Re-announce of WhatsApp link failed')
  }
}

function initWhatsApp(connection: signalR.HubConnection, sessionId: string): void {
  if (waStarted) return
  waStarted = true

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

  startWhatsApp(
    async (qrBase64) => {
      logger.info('[wa] QR generated — scan with WhatsApp on your phone')
      try {
        await connection.invoke('QrGenerated', sessionId, qrBase64)
      } catch (err) {
        logger.error({ err }, '[hub] Failed to send QR to Messenger-BE')
      }
    },
    async (phoneNumber) => {
      logger.info('[wa] Connected as +%s', phoneNumber)
      connectedPhoneNumber = phoneNumber
      setStatus('connected')
      try {
        await connection.invoke('Connected', sessionId, phoneNumber)
      } catch (err) {
        logger.error({ err }, '[hub] Failed to send Connected event')
      }
    },
    async (reason, shouldReconnect) => {
      logger.info('[wa] Disconnected: %s', reason)
      waStarted = false
      connectedPhoneNumber = null
      setStatus('disconnected')
      try {
        await connection.invoke('Disconnected', sessionId, reason)
      } catch { /* hub may be offline */ }

      if (shouldReconnect) {
        logger.info('[wa] Reconnecting in 5s…')
        reconnectTimer = setTimeout(() => initWhatsApp(connection, sessionId), 5000)
      } else {
        logger.warn('[wa] Logged out — delete wa_session/ and re-pair to reconnect')
      }
    },
    async (msg) => {
      logger.info('[wa] Inbound from %s', msg.from)
      try {
        await connection.invoke('MessageInbound', {
          sessionId,
          agentId: localSession?.agentId ?? '',
          from: msg.from,
          // A new field on an existing payload, which SignalR resolves by method name and
          // arity — a connector that predates this simply omits it, and the server reads the
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
        })
      } catch (err) {
        logger.error({ err }, '[hub] Failed to forward inbound message')
      }
    },
    (audio, mimeType, seconds, messageId) =>
      transcribeVoiceNote(sessionId, audio, mimeType, seconds, messageId),
  ).catch((err) => {
    logger.error({ err }, '[wa] Startup error')
    waStarted = false
  })
}
