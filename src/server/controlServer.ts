import * as http from 'http'
import pino, { Logger } from 'pino'
import { SessionManager } from './sessionManager'
import { readBodyLimited, PayloadTooLargeError, RequestTimeoutError } from './guards'

const log: Logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })

/**
 * Tiny HTTP control API the platform (CMS-Web / CMS-BE) calls to provision and
 * tear down tenant sessions on this hosted connector server.
 *
 *   POST   /sessions        { code }   → start a new tenant (Pair with the code)
 *   DELETE /sessions/:id                → stop + wipe a tenant
 *   GET    /sessions                    → list live sessionIds
 *   GET    /health                      → liveness + session count
 */
export function createControlServer(manager: SessionManager, bodyTimeoutMs = 10_000): http.Server {
  return http.createServer((req, res) => {
    handleRequest(req, res, manager, bodyTimeoutMs).catch((err) => {
      log.error({ err }, '[control] unhandled request error')
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
    })
  })
}

export function startControlServer(manager: SessionManager, port: number): void {
  const server = createControlServer(manager)
  server.listen(port, () => log.info('[control] listening on port %d', port))
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  manager: SessionManager,
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
    sendJson(res, 200, { sessions: manager.list() })
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
    if (!manager.isValidSessionId(sessionId)) {
      sendJson(res, 400, { error: 'invalid session id' })
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
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
