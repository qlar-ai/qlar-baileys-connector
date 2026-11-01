export type Command =
  | { kind: 'version' }
  | { kind: 'run'; hubUrl: string; stateDir: string }
  | { kind: 'enroll'; hubUrl: string; stateDir: string; code?: string }

/** A mistake in how the connector was started; the message tells the operator what to change. */
export class UsageError extends Error {}

const COMMANDS = 'enroll, run, version'

/**
 * Reads one flag's value from `args`. A flag wins over the environment, and a value that is empty
 * once trimmed counts as missing: `echo KEY=value >> .env` in Windows `cmd` writes a trailing space
 * and CRLF into the file, which would otherwise end up inside the hub URL.
 */
function option(args: string[], flag: string, envValue: string | undefined): string | undefined {
  const at = args.indexOf(flag)
  const raw = at >= 0 ? args[at + 1] : envValue
  const value = raw?.trim()
  return value ? value : undefined
}

/** `argv` is `process.argv.slice(2)`: the command first, then its flags. */
export function parseCommand(argv: string[], env: NodeJS.ProcessEnv): Command {
  const [name, ...args] = argv
  if (name === 'version') return { kind: 'version' }
  if (name !== 'enroll' && name !== 'run') {
    throw new UsageError(`Unknown or missing command. Use one of: ${COMMANDS}.`)
  }

  const hubUrl = option(args, '--hub', env.QLAR_HUB_URL)
  if (!hubUrl) throw new UsageError('A hub URL is required: --hub or QLAR_HUB_URL')
  const stateDir = option(args, '--state-dir', env.CONNECTOR_DATA_DIR) ?? './state'

  if (name === 'run') return { kind: 'run', hubUrl, stateDir }
  return { kind: 'enroll', hubUrl, stateDir, code: option(args, '--code', env.QLAR_PAIRING_CODE) }
}
