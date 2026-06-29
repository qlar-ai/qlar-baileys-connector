import * as signalR from '@microsoft/signalr'
import pino from 'pino'
import { loadSession, saveSession, clearSession, LocalSession } from './session'
import { startWhatsApp, sendMessage, logout, stopWhatsApp } from './whatsapp'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

let localSession: LocalSession | null = null
let waStarted = false
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

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
  })

  connection.onreconnected(async () => {
    logger.info('[hub] Reconnected — re-registering session')
    await reconnect(connection)
  })

  connection.on('SendMessage', async (payload: { to: string; text: string }) => {
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
      await sendMessage(payload.to, payload.text)
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
    process.exit(1)
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
    process.exit(1)
  }
}

async function reconnect(connection: signalR.HubConnection): Promise<void> {
  const session = loadSession()
  if (!session) {
    logger.error('[hub] No session.json found — run with --code <PAIRING_CODE> first')
    process.exit(1)
  }
  localSession = session
  logger.info('[hub] Reconnecting session — SessionId: %s', session.sessionId)
  try {
    await connection.invoke('Reconnect', session.sessionId)
    if (!waStarted) initWhatsApp(connection, session.sessionId)
  } catch (err) {
    logger.error({ err }, '[hub] Reconnect failed')
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
      try {
        await connection.invoke('Connected', sessionId, phoneNumber)
      } catch (err) {
        logger.error({ err }, '[hub] Failed to send Connected event')
      }
    },
    async (reason, shouldReconnect) => {
      logger.info('[wa] Disconnected: %s', reason)
      waStarted = false
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
          text: msg.text,
          messageId: msg.messageId,
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
