import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newConnectorToken, registerWithHub, secureAfterPair, tokenToPresent } from './hubHandshake'

type Call = { method: string; args: unknown[] }

function fakeConn(behaviour: (method: string, args: unknown[]) => Promise<unknown>) {
  const calls: Call[] = []
  return {
    calls,
    invoke: (method: string, ...args: unknown[]) => {
      calls.push({ method, args })
      return behaviour(method, args)
    },
  }
}

test('registerWithHub_ServerAccepts_ReturnsOk', async () => {
  const conn = fakeConn(async () => undefined)
  const result = await registerWithHub(conn, 'sess-1', 'tok-1')
  assert.equal(result, 'ok')
  assert.deepEqual(conn.calls, [{ method: 'ReconnectSecure', args: ['sess-1', 'tok-1'] }])
})

test('registerWithHub_OldServerLacksMethod_FallsBackToReconnect', async () => {
  const conn = fakeConn(async (method) => {
    if (method === 'ReconnectSecure') {
      throw new Error("Failed to invoke 'ReconnectSecure' due to an error on the server. HubException: Method does not exist.")
    }
    return undefined
  })
  const result = await registerWithHub(conn, 'sess-1', 'tok-1')
  assert.equal(result, 'ok')
  assert.deepEqual(conn.calls, [
    { method: 'ReconnectSecure', args: ['sess-1', 'tok-1'] },
    { method: 'Reconnect', args: ['sess-1'] },
  ])
})

test('registerWithHub_TokenRejected_ReturnsRejected', async () => {
  const conn = fakeConn(async () => {
    throw new Error("An unexpected error occurred invoking 'ReconnectSecure' on the server. HubException: Connector token rejected.")
  })
  const result = await registerWithHub(conn, 'sess-1', 'tok-1')
  assert.equal(result, 'rejected')
  // No fallback to the legacy path: a mismatch must never be retried another way.
  assert.equal(conn.calls.length, 1)
})

test('registerWithHub_OtherError_Rethrows', async () => {
  const conn = fakeConn(async () => {
    throw new Error('HubException: Messenger account not found.')
  })
  await assert.rejects(registerWithHub(conn, 'sess-1', 'tok-1'), /account not found/)
  assert.equal(conn.calls.length, 1)
})

test('registerWithHub_FallbackReconnectFails_Rethrows', async () => {
  const conn = fakeConn(async (method) => {
    if (method === 'ReconnectSecure') throw new Error('Method does not exist.')
    throw new Error('HubException: Messenger account not found.')
  })
  await assert.rejects(registerWithHub(conn, 'sess-1', 'tok-1'), /account not found/)
})

test('newConnectorToken_IsUniqueAnd43Chars', () => {
  const tokens = new Set<string>()
  for (let i = 0; i < 50; i++) {
    const t = newConnectorToken()
    assert.equal(t.length, 43)
    assert.match(t, /^[A-Za-z0-9_-]{43}$/)
    tokens.add(t)
  }
  assert.equal(tokens.size, 50)
})

test('tokenToPresent_StoredToken_PresentsItNotFresh', () => {
  assert.deepEqual(tokenToPresent('stored-token'), { token: 'stored-token', fresh: false })
})

for (const [name, value] of [['Undefined', undefined], ['Null', null], ['Empty', '']] as const) {
  test(`tokenToPresent_${name}_GeneratesFresh`, () => {
    const r = tokenToPresent(value)
    assert.equal(r.fresh, true)
    assert.equal(r.token.length, 43)
  })
}

test('secureAfterPair_ServerAccepts_ReturnsToken', async () => {
  const conn = fakeConn(async () => undefined)
  const result = await secureAfterPair(conn, 'sess-1')
  assert.equal(result.outcome, 'secured')
  assert.ok(result.outcome === 'secured' && /^[A-Za-z0-9_-]{43}$/.test(result.token))
  assert.equal(conn.calls.length, 1)
  assert.equal(conn.calls[0].method, 'ReconnectSecure')
  assert.equal(conn.calls[0].args[0], 'sess-1')
  assert.equal(conn.calls[0].args[1], result.outcome === 'secured' ? result.token : undefined)
})

test('secureAfterPair_OldServerLacksMethod_ReturnsNoToken_NoThrow', async () => {
  const conn = fakeConn(async () => {
    throw new Error("Failed to invoke 'ReconnectSecure' due to an error on the server. HubException: Method does not exist.")
  })
  const result = await secureAfterPair(conn, 'sess-1')
  assert.deepEqual(result, { outcome: 'unsecured', reason: 'old-server' })
  // Never the legacy Reconnect here: the account does not exist yet during the wizard.
  assert.deepEqual(conn.calls.map((c) => c.method), ['ReconnectSecure'])
})

test('secureAfterPair_TokenRejected_ReturnsRejected', async () => {
  const conn = fakeConn(async () => {
    throw new Error('HubException: Connector token rejected.')
  })
  const result = await secureAfterPair(conn, 'sess-1')
  assert.deepEqual(result, { outcome: 'rejected' })
  assert.equal(conn.calls.length, 1)
})

test('secureAfterPair_OtherError_ReturnsNoToken_NoThrow', async () => {
  const boom = new Error('connection lost')
  const conn = fakeConn(async () => {
    throw boom
  })
  const result = await secureAfterPair(conn, 'sess-1')
  assert.equal(result.outcome, 'unsecured')
  assert.ok(result.outcome === 'unsecured' && result.reason === 'error' && result.error === boom)
  assert.deepEqual(conn.calls.map((c) => c.method), ['ReconnectSecure'])
})
