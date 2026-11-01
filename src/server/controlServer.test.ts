import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'http'
import * as net from 'net'
// controlServer depends only on guards and a ControlManager interface, so no Baileys stub is needed.
import { createControlServer } from './controlServer'

/**
 * A ControlManager double: live session `live-1` holding token `secret-token`, and live session
 * `live-unsecured` with no token (paired by an old connector / against an old server).
 */
function fakeManager() {
  const calls = { stop: [] as string[], startFromCode: [] as string[] }
  const tokens = new Map<string, string>([['live-1', 'secret-token']])
  const live = new Set<string>(['live-1', 'live-unsecured'])
  return {
    calls,
    count: () => live.size,
    isLive: (sessionId: string) => live.has(sessionId),
    startFromCode: async (code: string) => {
      calls.startFromCode.push(code)
    },
    tokenFor: (sessionId: string) => tokens.get(sessionId),
    stop: async (sessionId: string) => {
      calls.stop.push(sessionId)
    },
  }
}

async function withServer(
  timeoutMs: number,
  fn: (port: number, manager: ReturnType<typeof fakeManager>) => Promise<void>,
): Promise<void> {
  const manager = fakeManager()
  const server = createControlServer(manager, timeoutMs)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  try {
    await fn((server.address() as net.AddressInfo).port, manager)
  } finally {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  }
}

type Res = { status: number; body: string; headers: http.IncomingHttpHeaders }

function request(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: opts.headers }, (r) => {
      let b = ''
      r.on('data', (c) => (b += c))
      r.on('end', () => resolve({ status: r.statusCode ?? 0, body: b, headers: r.headers }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

test('postSessions_OversizedBody_ClientReceives413Json', async () => {
  await withServer(10_000, async (port) => {
    const res = await request(port, 'POST', '/sessions', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'x'.repeat(5 * 1024) }),
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

test('GET_sessions_ReturnsCountOnly_NoIds', async () => {
  await withServer(10_000, async (port) => {
    const res = await request(port, 'GET', '/sessions')
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { count: 2 })
    assert.ok(!res.body.includes('live-1'))
  })
})

test('GET_health_Unchanged', async () => {
  await withServer(10_000, async (port) => {
    const res = await request(port, 'GET', '/health')
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true, sessions: 2 })
  })
})

test('DELETE_NoBearer_401_AndStopNotCalled', async () => {
  await withServer(10_000, async (port, manager) => {
    const res = await request(port, 'DELETE', '/sessions/live-1')
    assert.equal(res.status, 401)
    assert.deepEqual(manager.calls.stop, [])
  })
})

test('DELETE_WrongBearer_401', async () => {
  await withServer(10_000, async (port, manager) => {
    // Same length and a different length: neither may throw inside the comparison.
    for (const bearer of ['secret-tokeX', 'nope', 'secret-token-but-longer']) {
      const res = await request(port, 'DELETE', '/sessions/live-1', { headers: { Authorization: `Bearer ${bearer}` } })
      assert.equal(res.status, 401, bearer)
    }
    const nonBearer = await request(port, 'DELETE', '/sessions/live-1', { headers: { Authorization: 'Basic secret-token' } })
    assert.equal(nonBearer.status, 401)
    assert.deepEqual(manager.calls.stop, [])
  })
})

test('DELETE_CorrectBearer_200_AndStopCalled', async () => {
  await withServer(10_000, async (port, manager) => {
    const res = await request(port, 'DELETE', '/sessions/live-1', { headers: { Authorization: 'Bearer secret-token' } })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true })
    assert.deepEqual(manager.calls.stop, ['live-1'])
  })
})

test('DELETE_UnknownSession_200_AndStopNotCalled', async () => {
  await withServer(10_000, async (port, manager) => {
    const res = await request(port, 'DELETE', '/sessions/unknown-9', { headers: { Authorization: 'Bearer anything' } })
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true })
    assert.deepEqual(manager.calls.stop, [])
  })
})

test('DELETE_DotDot_400', async () => {
  await withServer(10_000, async (port, manager) => {
    for (const id of ['..', '%2E%2E', '..%2Fkeep.txt']) {
      const res = await request(port, 'DELETE', `/sessions/${id}`, { headers: { Authorization: 'Bearer secret-token' } })
      assert.equal(res.status, 400, id)
    }
    assert.deepEqual(manager.calls.stop, [])
  })
})

test('POST_sessions_ValidCode_202', async () => {
  await withServer(10_000, async (port, manager) => {
    // No Authorization header: the browser's hosted pairing calls this directly, the code is the credential.
    const res = await request(port, 'POST', '/sessions', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'ABC123' }),
    })
    assert.equal(res.status, 202)
    assert.deepEqual(JSON.parse(res.body), { ok: true })
    assert.deepEqual(manager.calls.startFromCode, ['ABC123'])
  })
})

test('POST_sessions_Oversize_413', async () => {
  await withServer(10_000, async (port, manager) => {
    const res = await request(port, 'POST', '/sessions', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'x'.repeat(5 * 1024) }),
    })
    assert.equal(res.status, 413)
    assert.deepEqual(manager.calls.startFromCode, [])
  })
})

test('OPTIONS_AllowsPostOnly', async () => {
  await withServer(10_000, async (port) => {
    const res = await request(port, 'OPTIONS', '/sessions')
    assert.equal(res.status, 204)
    assert.equal(res.headers['access-control-allow-methods'], 'POST, OPTIONS')
    assert.equal(res.headers['access-control-allow-origin'], '*')
    assert.equal(res.headers['access-control-allow-headers'], 'Content-Type')
  })
})

test('DELETE_LiveUnsecuredSession_StopsWithoutBearer', async () => {
  await withServer(10_000, async (port, manager) => {
    // Exactly as before tokens: an unsecured session is revoked without a bearer.
    const res = await request(port, 'DELETE', '/sessions/live-unsecured')
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true })
    assert.deepEqual(manager.calls.stop, ['live-unsecured'])
  })
})

test('DELETE_LiveSecuredSession_NoBearer_401', async () => {
  await withServer(10_000, async (port, manager) => {
    const res = await request(port, 'DELETE', '/sessions/live-1')
    assert.equal(res.status, 401)
    assert.deepEqual(manager.calls.stop, [])
  })
})

test('DELETE_NotLiveSession_200_StopNotCalled', async () => {
  await withServer(10_000, async (port, manager) => {
    const res = await request(port, 'DELETE', '/sessions/gone-7')
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { ok: true })
    assert.deepEqual(manager.calls.stop, [])
  })
})
