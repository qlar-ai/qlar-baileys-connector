import pino from 'pino'
import { hasEnrolledSession, runEnroll, runRestore } from './enroll'
import { parseCommand, UsageError } from './options'
import { assertNodeVersion, connectorVersion, describeFailure } from './runtime'

// The connector a customer runs on their own machine: one number, outbound connections only.
// Unlike the hosted server it opens no HTTP port, so nothing on this machine can be asked to
// start or wipe a session.
async function main(): Promise<void> {
  assertNodeVersion(process.versions.node)

  const command = parseCommand(process.argv.slice(2), process.env)
  if (command.kind === 'version') {
    console.log(connectorVersion(process.env))
    return
  }

  // Loopback hubs use a self-signed dev cert Node rejects by default (local development only).
  if (/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/i.test(command.hubUrl)) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }

  // Loaded only now: on a Node that is too old the dependencies can fail to import with an obscure
  // error, and the version check above must be what the operator reads.
  const { SessionManager } = await import('../server/sessionManager')
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })
  const manager = new SessionManager(command.hubUrl, command.stateDir)
  const enrolled = hasEnrolledSession(command.stateDir)
  logger.info({ version: connectorVersion(process.env), stateDir: command.stateDir }, `[connector] ${command.kind}`)

  try {
    if (command.kind === 'enroll') {
      await runEnroll(manager, { code: command.code, enrolled }, (message) => logger.info(`[connector] ${message}`))
    } else {
      await runRestore(manager, enrolled)
    }
  } catch (err) {
    if (err instanceof UsageError) throw err
    throw new Error(describeFailure(err, command.hubUrl))
  }

  // The sessions' sockets keep the process alive; stop promptly when the container is stopped.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => process.exit(0))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
