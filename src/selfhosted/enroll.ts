import * as fs from 'fs'
import * as path from 'path'
import { UsageError } from './options'

/** The slice of SessionManager the entry point needs; lets tests drive it without a hub. */
export type ManagerLike = {
  startFromCode(code: string): Promise<void>
  restore(): Promise<void>
  count(): number
}

/** True when the state directory already holds a paired session (a `<sessionId>/meta.json`). */
export function hasEnrolledSession(stateDir: string): boolean {
  if (!fs.existsSync(stateDir)) return false
  return fs
    .readdirSync(stateDir, { withFileTypes: true })
    .some((entry) => entry.isDirectory() && fs.existsSync(path.join(stateDir, entry.name, 'meta.json')))
}

/**
 * `enroll` is safe to re-run. A container restarted with its original command still has the spent
 * code in its environment; a populated state directory means "already linked", so the code is
 * ignored and the stored session reconnects. One state directory holds one number.
 */
export async function runEnroll(
  manager: ManagerLike,
  opts: { code?: string; enrolled: boolean },
  log: (message: string) => void,
): Promise<void> {
  if (opts.enrolled) {
    log('already enrolled: reconnecting the stored session and ignoring the pairing code. To link another number use a separate state directory or container.')
    await manager.restore()
    return
  }
  if (!opts.code) {
    throw new UsageError('A pairing code is required to enroll: --code or QLAR_PAIRING_CODE. Create a new one in the Qlar CMS.')
  }
  await manager.startFromCode(opts.code)
}

export async function runRestore(manager: ManagerLike, enrolled: boolean): Promise<void> {
  if (!enrolled) {
    throw new UsageError('Nothing is enrolled in this state directory. Run "enroll" with a pairing code first.')
  }
  await manager.restore()
}
