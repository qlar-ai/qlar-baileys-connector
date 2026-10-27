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
 * `connectorToken` / `pendingConnectorToken` are absent in meta.json files written before tokens existed.
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
        onPendingToken: (sessionId, token) => this.persistPendingToken(sessionId, token),
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
    const dir = resolveSessionDir(this.dataRoot, meta?.sessionId ?? '')
    if (!dir) {
      // Thrown back into pair(), so the pairing fails instead of writing outside the data root.
      throw new Error('Refusing to register an unsafe session id')
    }
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
   * Merge a token the hub confirmed into meta.json as `connectorToken` (promoted), dropping any
   * pending one, so the next restart presents the same token.
   */
  private persistToken(sessionId: string, token: string): void {
    this.updateMeta(sessionId, 'connector token persisted', (meta) => {
      const rest: SessionMeta = { ...meta }
      delete rest.pendingConnectorToken
      return { ...rest, connectorToken: token }
    })
  }

  /**
   * Remember a self-generated token before it is first presented, so a lost reply or a restart
   * re-presents the same one. Never used by {@link tokenFor}.
   */
  private persistPendingToken(sessionId: string, token: string): void {
    this.updateMeta(sessionId, 'pending connector token persisted', (meta) => ({ ...meta, pendingConnectorToken: token }))
  }

  /** Read-modify-write of a session's meta.json. Failure is logged (never the token), not thrown. */
  private updateMeta(sessionId: string, what: string, change: (meta: SessionMeta) => SessionMeta): void {
    const dir = resolveSessionDir(this.dataRoot, sessionId)
    if (!dir) {
      this.log.warn({ sessionId }, '[manager] refusing to update meta.json: session id does not resolve inside the data root')
      return
    }
    const metaPath = path.join(dir, 'meta.json')
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionMeta
      fs.writeFileSync(metaPath, JSON.stringify(change(meta), null, 2), 'utf-8')
      this.log.info({ sessionId, what }, '[manager] meta.json updated')
    } catch (err) {
      this.log.error({ err, sessionId, what }, '[manager] meta.json update failed')
    }
  }

  isLive(sessionId: string): boolean {
    return this.sessions.has(sessionId)
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

      let session: ConnectorSession | undefined
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SessionMeta
        const restored: ConnectorSession = new ConnectorSession(
          this.hubUrl,
          this.dataRoot,
          {
            sessionId: meta.sessionId,
            agentId: meta.agentId,
            // Both absent in meta.json written before tokens; the session then generates one.
            connectorToken: nonEmptyString(meta.connectorToken),
            pendingConnectorToken: nonEmptyString(meta.pendingConnectorToken),
          },
          {
            onRegistered: (m) => this.register(m, restored),
            onClosed: (id) => this.remove(id),
            onToken: (id, token) => this.persistToken(id, token),
            onPendingToken: (id, token) => this.persistPendingToken(id, token),
          },
        )
        session = restored
        this.sessions.set(meta.sessionId, restored)
        await restored.start()
        this.log.info({ sessionId: meta.sessionId }, '[manager] restored session')
      } catch (err) {
        // Don't leave a dead entry in the map if start() failed, nor its SignalR connection open:
        // left running it would keep auto-reconnecting and re-register on the hub with no WhatsApp behind it.
        this.sessions.delete(sessionId)
        if (session) await session.stop().catch(() => { /* ignore */ })

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

  count(): number {
    return this.sessions.size
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}
