import { EventEmitter } from 'events'
import * as signalR from '@microsoft/signalr'
import pino from 'pino'
import { loadSession, saveSession, clearSession, LocalSession } from './session'
import { startWhatsApp, sendMessage, logout, stopWhatsApp } from './whatsapp'

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
    await announceWaState(connection)
    if (!waStarted) initWhatsApp(connection, session.sessionId)
  } catch (err) {
    logger.error({ err }, '[hub] Reconnect failed')
    hubEvents.emit('error', 'Reconnect ke Messenger-BE gagal.')
  }
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
        })
      } catch (err) {
        logger.error({ err }, '[hub] Failed to forward inbound message')
      }
    },
  ).catch((err) => {
    logger.error({ err }, '[wa] Startup error')
    waStarted = false
  })
}
