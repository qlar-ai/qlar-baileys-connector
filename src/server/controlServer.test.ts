import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'http'
import * as net from 'net'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Module from 'module'

// Same stub as sessionManager.test.ts: the real ConnectorSession drags in Baileys, which tsx can't load.
const origLoad = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === './connectorSession') return { ConnectorSession: class {} }
  if (request === './waSession') return { isLinked: () => true }
  return origLoad.call(this, request, ...rest)
}
const { SessionManager } = require('./sessionManager') as typeof import('./sessionManager')
const { createControlServer } = require('./controlServer') as typeof import('./controlServer')

async function withServer(timeoutMs: number, fn: (port: number) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'))
  const server = createControlServer(new SessionManager('http://localhost/hub', root), timeoutMs)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    await fn((server.address() as net.AddressInfo).port)
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
}

test('postSessions_OversizedBody_ClientReceives413Json', async () => {
  await withServer(10_000, async (port) => {
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/sessions', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (r) => {
          let b = ''
          r.on('data', (c) => (b += c))
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: b }))
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify({ code: 'x'.repeat(5 * 1024) }))
    })
    assert.equal(res.status, 413)
    assert.deepEqual(JSON.parse(res.body), { error: 'request body too large' })
  })
})

test('postSessions_StalledClient_ClientReceives408Json', async () => {
  await withServer(100, async (port) => {
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        // Promise a body, never send it.
        sock.write('POST /sessions HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 50\r\n\r\n{')
      })
      let data = ''
      sock.on('data', (c) => (data += c))
      sock.on('end', () => resolve(data))
      sock.on('close', () => resolve(data))
      sock.on('error', reject)
    })
    assert.match(raw, /^HTTP\/1\.1 408 /)
    assert.match(raw, /\{"error":"request timed out"\}/)
  })
})
