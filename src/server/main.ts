import pino, { Logger } from 'pino'
import { SessionManager } from './sessionManager'
import { startControlServer } from './controlServer'
import { requireHubUrl } from './config'
import { describeKeyring, getProcessKeyring, StateKeyring, stateStartupWarning } from './stateCrypto'

const logger: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

// Entry point for the Public hosting server: one process, many tenant sessions.
// Config comes entirely from env (the Control Plane / deployment sets these):
//   HUB_URL             — Messenger-BE SignalR hub the connectors register with
//   CONNECTOR_DATA_DIR  — where per-tenant state lives (mount a volume here)
//   PORT                — HTTP control API port
//   CONNECTOR_STATE_KEY — base64 32-byte key encrypting session state at rest (hosted: a Key Vault
//                         reference). Optional CONNECTOR_STATE_KEY_VERSION (default v1), older keys as
//                         CONNECTOR_STATE_KEY_<version>, CONNECTOR_STATE_MODE=decrypt for a rollback.
let HUB_URL: string
try {
  HUB_URL = requireHubUrl(process.env)
} catch (err) {
  logger.error({ err }, '[server] refusing to start without a hub URL')
  process.exit(1)
}
let KEYRING: StateKeyring
try {
  KEYRING = getProcessKeyring()
} catch (err) {
  // A key that is set but unusable must stop the process: guessing would mean writing plaintext, or
  // skipping every encrypted session.
  logger.error({ err }, '[server] refusing to start with an unusable state key configuration')
  process.exit(1)
}
const DATA_DIR = process.env.CONNECTOR_DATA_DIR ?? './data'
const PORT = Number(process.env.PORT ?? process.env.CONTROL_PORT ?? 8080)

// Loopback hubs use a self-signed dev cert Node rejects by default (local dev).
if (/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/i.test(HUB_URL)) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

async function main(): Promise<void> {
  logger.info({ hubUrl: HUB_URL, dataDir: DATA_DIR, port: PORT, state: describeKeyring(KEYRING) }, '[server] starting multi-session connector')
  const stateWarning = stateStartupWarning(KEYRING, DATA_DIR)
  if (stateWarning) logger.warn(`[server] ${stateWarning}`)
  const manager = new SessionManager(HUB_URL, DATA_DIR)

  // Open the HTTP port FIRST so Azure's startup probe passes immediately. restore()
  // reconnects every persisted session (a SignalR connection + Baileys socket each)
  // and can take minutes; awaiting it before listening makes the platform's 230s
  // start probe time out and kill the container in a crash loop.
  startControlServer(manager, PORT)

  manager.restore().catch((err) => logger.error({ err }, '[server] session restore failed'))
}

main().catch((err) => {
  logger.error({ err }, '[server] fatal startup error')
  process.exit(1)
})
