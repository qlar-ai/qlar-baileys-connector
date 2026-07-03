import * as http from 'http'
import pino from 'pino'
import { openInBrowser } from './browser'
import { connectToHub, getStatus, hubEvents } from './hub'
import { INDEX_HTML } from './indexHtml'
import { clearSession, loadSession } from './session'
import { resetLocalWaSession } from './whatsapp'

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })
const PORT = Number(process.env.CONNECTOR_GUI_PORT ?? 47890)

// Runs the local GUI: a single HTML page served over plain HTTP + SSE, opened
// in the user's browser. Everything the CLI used to take as flags (pairing
// code, "clear session") is now driven from that page instead of the
// terminal — see indexHtml.ts for the client side.
export function startServer(hubUrl: string): void {
  let started = false

  hubEvents.on('sessionCleared', () => {
    started = false
  })

  // Any reported error means this connect attempt didn't end up paired/running
  // (bad code, unreachable hub, no session yet) — let the user retry instead
  // of requiring a full app restart.
  hubEvents.on('error', () => {
    started = false
  })

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      logger.error({ err }, '[server] Unhandled request error')
      res.writeHead(500).end()
    })
  })

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? ''

    if (req.method === 'GET' && url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(INDEX_HTML)
      return
    }

    if (req.method === 'GET' && url === '/api/status') {
      const session = loadSession()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ hasSession: !!session, status: getStatus() }))
      return
    }

    if (req.method === 'GET' && url === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      res.write(': connected\n\n')

      const onStatus = (status: string) => res.write(`event: status\ndata: ${JSON.stringify({ status })}\n\n`)
      const onError = (message: string) => res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`)
      const onSessionCleared = () => res.write('event: sessionCleared\ndata: {}\n\n')

      hubEvents.on('status', onStatus)
      hubEvents.on('error', onError)
      hubEvents.on('sessionCleared', onSessionCleared)

      req.on('close', () => {
        hubEvents.off('status', onStatus)
        hubEvents.off('error', onError)
        hubEvents.off('sessionCleared', onSessionCleared)
      })
      return
    }

    if (req.method === 'POST' && url === '/api/connect') {
      if (started) {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Sudah berjalan.' }))
        return
      }
      const body = await readBody(req)
      const { code } = body ? JSON.parse(body) : {}
      started = true
      connectToHub(hubUrl, code || undefined)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === 'POST' && url === '/api/clear-session') {
      resetLocalWaSession()
      clearSession()
      started = false
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    res.writeHead(404)
    res.end()
  }

  server.listen(PORT, () => {
    const localUrl = `http://localhost:${PORT}`
    logger.info('[server] Pusaka Connector GUI running at %s', localUrl)
    openInBrowser(localUrl)
  })
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
  })
}
