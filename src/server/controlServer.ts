import * as http from 'http'
import * as path from 'path'
import { timingSafeEqual } from 'crypto'
import pino, { Logger } from 'pino'
import { readBodyLimited, PayloadTooLargeError, RequestTimeoutError, resolveSessionDir } from './guards'

const log: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

/**
 * Tiny HTTP control API the platform (CMS-Web / CMS-BE) calls to provision and
 * tear down tenant sessions on this hosted connector server.
 *
 *   POST   /sessions        { code }   → start a new tenant (Pair with the code; the code is the credential)
 *   DELETE /sessions/:id                → stop + wipe a tenant; requires `Authorization: Bearer <session token>`
 *                                         (secured sessions only; unsecured ones are revoked as before)
 *   GET    /sessions                    → { count } only - never the tenant ids
 *   GET    /health                      → liveness + session count
 */
export interface ControlManager {
  count(): number
  /** True when the session is live in this process (with or without a token). */
  isLive(sessionId: string): boolean
  startFromCode(code: string): Promise<void>
  tokenFor(sessionId: string): string | undefined
  stop(sessionId: string): Promise<void>
}

/**
 * Session ids are checked for shape with the same guard the manager uses before it wipes a
 * directory. The guard only depends on the id (no separators, not '.' / '..'), so any root works.
 */
const ID_CHECK_ROOT = path.resolve('session-id-check')

function isSafeSessionId(sessionId: string): boolean {
  return resolveSessionDir(ID_CHECK_ROOT, sessionId) !== null
}

/** Constant-time comparison of the presented bearer against the session's token; never throws on length. */
function bearerMatches(header: string | undefined, expected: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '')
  if (!match) return false
  const presented = Buffer.from(match[1].trim(), 'utf-8')
  const wanted = Buffer.from(expected, 'utf-8')
  if (presented.length !== wanted.length) {
    // Still burn a comparison so a length mismatch is not measurably faster.
    timingSafeEqual(wanted, wanted)
    return false
  }
  return timingSafeEqual(presented, wanted)
}

export function createControlServer(manager: ControlManager, bodyTimeoutMs = 10_000): http.Server {
  return http.createServer((req, res) => {
    handleRequest(req, res, manager, bodyTimeoutMs).catch((err) => {
      log.error({ err }, '[control] unhandled request error')
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
    })
  })
}

export function startControlServer(manager: ControlManager, port: number): void {
  const server = createControlServer(manager)
  server.listen(port, () => log.info('[control] listening on port %d', port))
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: ControlManager,
  bodyTimeoutMs: number,
): Promise<void> {
  applyCors(res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = req.url ?? ''

  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, { ok: true, sessions: manager.count() })
    return
  }

  if (req.method === 'GET' && url === '/sessions') {
    // A count only: the ids are the handles a caller would need to act on another tenant.
    sendJson(res, 200, { count: manager.count() })
    return
  }

  if (req.method === 'POST' && url === '/sessions') {
    let body: string
    try {
      body = await readBodyLimited(req, 4096, bodyTimeoutMs)
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJsonAndClose(req, res, 413, { error: 'request body too large' })
      } else if (err instanceof RequestTimeoutError) {
        sendJsonAndClose(req, res, 408, { error: 'request timed out' })
      } else {
        log.warn({ err }, '[control] request body read failed')
      }
      return
    }
    let code: string | undefined
    try {
      code = body ? (JSON.parse(body).code as string) : undefined
    } catch {
      sendJson(res, 400, { error: 'invalid JSON body' })
      return
    }

    if (!code) {
      sendJson(res, 400, { error: 'code is required' })
      return
    }

    try {
      await manager.startFromCode(code)
      sendJson(res, 202, { ok: true })
    } catch (err) {
      log.error({ err }, '[control] startFromCode failed')
      sendJson(res, 502, { error: 'failed to start session — code may be invalid or expired' })
    }
    return
  }

  const deleteMatch = url.match(/^\/sessions\/([^/]+)$/)
  if (req.method === 'DELETE' && deleteMatch) {
    let sessionId: string
    try {
      sessionId = decodeURIComponent(deleteMatch[1])
    } catch {
      sendJson(res, 400, { error: 'invalid session id' })
      return
    }
    if (!isSafeSessionId(sessionId)) {
      sendJson(res, 400, { error: 'invalid session id' })
      return
    }
    if (!manager.isLive(sessionId)) {
      // Not live here: nothing is stopped or deleted, so this is idempotent.
      sendJson(res, 200, { ok: true })
      return
    }
    const token = manager.tokenFor(sessionId)
    // A live session that never registered a token is revoked exactly as before tokens existed.
    if (token !== undefined && !bearerMatches(req.headers.authorization, token)) {
      log.warn({ sessionId }, '[control] DELETE refused: bearer does not match the session token')
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    await manager.stop(sessionId)
    sendJson(res, 200, { ok: true })
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

function applyCors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  // Only the browser's hosted pairing (POST /sessions) is called cross-origin; DELETE is server-to-server.
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

/** Deliver the response first, then drop the connection so the unread body is not left streaming in. */
function sendJsonAndClose(req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
  res.end(JSON.stringify(body), () => req.destroy())
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
