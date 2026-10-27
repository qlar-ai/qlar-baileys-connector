import * as fs from 'fs'
import * as path from 'path'
import pino, { Logger } from 'pino'
import { ConnectorSession, SessionMeta } from './connectorSession'
import { isLinked } from './waSession'
import { resolveSessionDir } from './guards'
import type { ControlManager } from './controlServer'

/**
 * Holds every live tenant session in this process, keyed by sessionId. This is
 * the multi-session core of the Public hosting server: `startFromCode` spins up
 * a new tenant, `restore` brings persisted ones back after a restart, and each
 * tenant's `{ sessionId, agentId, hubUrl, connectorToken? }` is persisted to
 * `<dataRoot>/<sessionId>/meta.json` so restarts don't need a QR rescan.
 * `connectorToken` is absent in meta.json files written before tokens existed.
 */
export class SessionManager implements ControlManager {
  private readonly sessions = new Map<string, ConnectorSession>()
  private readonly log: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

  constructor(private readonly hubUrl: string, private readonly dataRoot: string) {
    fs.mkdirSync(this.dataRoot, { recursive: true })
  }

  /** Start a brand-new tenant session from a one-time pairing code. */
  async startFromCode(code: string): Promise<void> {
    const session = new ConnectorSession(
      this.hubUrl,
      this.dataRoot,
      { code },
      {
        onRegistered: (meta) => this.register(meta, session),
        onClosed: (sessionId) => this.remove(sessionId),
        onToken: (sessionId, token) => this.persistToken(sessionId, token),
      },
    )

    try {
      await session.start()
    } catch (err) {
      await session.stop().catch(() => { /* ignore */ })
      throw err
    }
  }

  private register(meta: SessionMeta, session: ConnectorSession): void {
    const dir = path.join(this.dataRoot, meta.sessionId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')

    const existing = this.sessions.get(meta.sessionId)
    if (existing && existing !== session) {
      existing.stop().catch(() => { /* ignore */ })
    }
    this.sessions.set(meta.sessionId, session)
    this.log.info({ sessionId: meta.sessionId, total: this.sessions.size }, '[manager] session registered')
  }

  /**
   * Merge a token the session generated itself (and the hub accepted) into its meta.json, so the
   * next restart presents the same one. Failure is logged, not thrown: the session keeps running,
   * and the next restart simply generates and registers another token.
   */
  private persistToken(sessionId: string, token: string): void {
    const dir = resolveSessionDir(this.dataRoot, sessionId)
    if (!dir) {
      this.log.warn({ sessionId }, '[manager] refusing to persist token: session id does not resolve inside the data root')
      return
    }
    const metaPath = path.join(dir, 'meta.json')
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionMeta
      fs.writeFileSync(metaPath, JSON.stringify({ ...meta, connectorToken: token }, null, 2), 'utf-8')
      this.log.info({ sessionId }, '[manager] connector token persisted')
    } catch (err) {
      this.log.error({ err, sessionId }, '[manager] failed to persist connector token')
    }
  }

  /** The live session's connector token, or undefined when the session is not live or has none yet. */
  tokenFor(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.getConnectorToken()
  }

  /**
   * Explicitly tear down a session (DELETE /sessions/:id), revoke its WhatsApp link, and
   * wipe its state.
   *
   * `revoke()` rather than `stop()` because this endpoint means "this tenant is finished",
   * not "pause it": closing the socket without logging out leaves a linked device stranded
   * on the customer's phone, holding one of their four slots against a session that no
   * longer exists anywhere.
   */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      await session.revoke()
      this.sessions.delete(sessionId)
    }
    this.wipe(sessionId)
    this.log.info({ sessionId, total: this.sessions.size }, '[manager] session stopped and revoked')
  }

  /** Logout or abandoned pairing — session already tore itself down, just clean up. */
  private remove(sessionId: string): void {
    this.sessions.delete(sessionId)
    this.wipe(sessionId)
    this.log.info({ sessionId, total: this.sessions.size }, '[manager] session removed')
  }

  private wipe(sessionId: string): void {
    const dir = resolveSessionDir(this.dataRoot, sessionId)
    if (!dir) {
      this.log.warn({ sessionId }, '[manager] refusing to wipe: session id does not resolve inside the data root')
      return
    }
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  }

  /** Bring back sessions persisted on disk after a process/container restart. */
  async restore(): Promise<void> {
    if (!fs.existsSync(this.dataRoot)) return

    for (const entry of fs.readdirSync(this.dataRoot, { withFileTypes: true })) {
      const sessionId = entry.name
      // Only tenant directories with a safe name are sessions; anything else is left alone, never deleted.
      if (!entry.isDirectory() || !resolveSessionDir(this.dataRoot, sessionId)) {
        this.log.warn({ entry: sessionId }, '[manager] ignoring non-session entry in data root')
        continue
      }
      // Idempotent: never open a second socket for a session already live in
      // this process — duplicate connections for one account make WhatsApp 401.
      if (this.sessions.has(sessionId)) continue

      const metaPath = path.join(this.dataRoot, sessionId, 'meta.json')

      // A dir with no meta.json or no linked WhatsApp creds was never fully paired (or was
      // half-wiped). Restoring it would spawn an unwatched QR nobody can scan — drop it.
      // isLinked rather than "wa_session exists": that folder is created before the first QR,
      // so an abandoned pairing leaves an empty one that used to pass this check.
      if (!fs.existsSync(metaPath) || !isLinked(path.join(this.dataRoot, sessionId))) {
        this.wipe(sessionId)
        this.log.warn({ sessionId }, '[manager] incomplete session on disk — wiped, not restored')
        continue
      }

      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionMeta
        const session = new ConnectorSession(
          this.hubUrl,
          this.dataRoot,
          {
            sessionId: meta.sessionId,
            agentId: meta.agentId,
            // Absent in meta.json written before tokens; the session then generates one.
            connectorToken: typeof meta.connectorToken === 'string' && meta.connectorToken ? meta.connectorToken : undefined,
          },
          {
            onRegistered: (m) => this.register(m, session),
            onClosed: (id) => this.remove(id),
            onToken: (id, token) => this.persistToken(id, token),
          },
        )
        this.sessions.set(meta.sessionId, session)
        await session.start()
        this.log.info({ sessionId: meta.sessionId }, '[manager] restored session')
      } catch (err) {
        // Don't leave a dead entry in the map if start() failed.
        this.sessions.delete(sessionId)

        // "Messenger account not found" comes from the hub (HubException) when the
        // account was deleted (e.g. via CMS). This session is permanently dead —
        // wipe it so it stops failing restore on every boot. Any other error is
        // treated as transient (hub blip) and kept for a retry next boot.
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('account not found')) {
          this.wipe(sessionId)
          this.log.warn({ sessionId }, '[manager] account gone — wiped orphaned session')
        } else {
          this.log.error({ err, sessionId }, '[manager] failed to restore session (will retry next boot)')
        }
      }
    }
  }

  /** True when the id maps to a directory strictly inside the data root. */
  isValidSessionId(sessionId: string): boolean {
    return resolveSessionDir(this.dataRoot, sessionId) !== null
  }

  list(): string[] {
    return Array.from(this.sessions.keys())
  }

  count(): number {
    return this.sessions.size
  }
}
