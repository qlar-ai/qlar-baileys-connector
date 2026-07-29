import * as fs from 'fs'
import * as path from 'path'
import pino, { Logger } from 'pino'
import { ConnectorSession, SessionMeta } from './connectorSession'

/**
 * Holds every live tenant session in this process, keyed by sessionId. This is
 * the multi-session core of the Public hosting server: `startFromCode` spins up
 * a new tenant, `restore` brings persisted ones back after a restart, and each
 * tenant's `{ sessionId, agentId, hubUrl }` is persisted to
 * `<dataRoot>/<sessionId>/meta.json` so restarts don't need a QR rescan.
 */
export class SessionManager {
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

  /** Explicitly tear down a session (DELETE /sessions/:id) and wipe its state. */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session) {
      await session.stop()
      this.sessions.delete(sessionId)
    }
    this.wipe(sessionId)
    this.log.info({ sessionId, total: this.sessions.size }, '[manager] session stopped')
  }

  /** Hub-initiated logout — session already tore itself down, just clean up. */
  private remove(sessionId: string): void {
    this.sessions.delete(sessionId)
    this.wipe(sessionId)
    this.log.info({ sessionId, total: this.sessions.size }, '[manager] session removed (logout)')
  }

  private wipe(sessionId: string): void {
    const dir = path.join(this.dataRoot, sessionId)
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
  }

  /** Bring back sessions persisted on disk after a process/container restart. */
  async restore(): Promise<void> {
    if (!fs.existsSync(this.dataRoot)) return

    for (const sessionId of fs.readdirSync(this.dataRoot)) {
      // Idempotent: never open a second socket for a session already live in
      // this process — duplicate connections for one account make WhatsApp 401.
      if (this.sessions.has(sessionId)) continue

      const metaPath = path.join(this.dataRoot, sessionId, 'meta.json')
      const waDir = path.join(this.dataRoot, sessionId, 'wa_session')

      // A dir with no meta.json or no WhatsApp creds was never fully paired (or was
      // half-wiped). Restoring it would spawn an unwatched QR nobody can scan — drop it.
      if (!fs.existsSync(metaPath) || !fs.existsSync(waDir)) {
        this.wipe(sessionId)
        this.log.warn({ sessionId }, '[manager] incomplete session on disk — wiped, not restored')
        continue
      }

      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionMeta
        const session = new ConnectorSession(
          this.hubUrl,
          this.dataRoot,
          { sessionId: meta.sessionId, agentId: meta.agentId },
          {
            onRegistered: (m) => this.register(m, session),
            onClosed: (id) => this.remove(id),
          },
        )
        this.sessions.set(meta.sessionId, session)
        await session.start()
        this.log.info({ sessionId: meta.sessionId }, '[manager] restored session')
      } catch (err) {
        // Don't leave a dead entry in the map if start() failed.
        this.sessions.delete(sessionId)
        this.log.error({ err, sessionId }, '[manager] failed to restore session')
      }
    }
  }

  list(): string[] {
    return Array.from(this.sessions.keys())
  }

  count(): number {
    return this.sessions.size
  }
}
