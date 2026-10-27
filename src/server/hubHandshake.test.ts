import { test } from 'node:test'
import assert from 'node:assert/strict'
import { afterHandshake, newConnectorToken, nextTokenToPresent, registerWithHub, secureAfterPair, shouldPersistToken } from './hubHandshake'

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

test('registerWithHub_Accepts_ReportsSecured', async () => {
  const conn = fakeConn(async () => undefined)
  const result = await registerWithHub(conn, 'sess-1', 'tok-1')
  assert.equal(result, 'secured')
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
  assert.equal(result, 'legacy')
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
  // The token is handed back so it can be kept as pending: the server may have stored it before the failure.
  assert.ok(result.outcome === 'unsecured' && result.reason === 'error' && result.token === conn.calls[0].args[1])
  assert.deepEqual(conn.calls.map((c) => c.method), ['ReconnectSecure'])
})

test('registerWithHub_OldServer_ReportsLegacy', async () => {
  const conn = fakeConn(async (method) => {
    if (method === 'ReconnectSecure') throw new Error('HubException: Method does not exist.')
    return undefined
  })
  assert.equal(await registerWithHub(conn, 'sess-1', 'tok-1'), 'legacy')
})

test('shouldPersistToken_SecuredAndFresh_Persists', () => {
  assert.equal(shouldPersistToken('secured', true), true)
})

test('shouldPersistToken_SecuredStoredToken_NothingNewToPersist', () => {
  assert.equal(shouldPersistToken('secured', false), false)
})

for (const fresh of [true, false]) {
  test(`shouldPersistToken_Legacy_Fresh${fresh}_NothingPersisted`, () => {
    assert.equal(shouldPersistToken('legacy', fresh), false)
  })
  test(`shouldPersistToken_Rejected_Fresh${fresh}_NothingPersisted`, () => {
    assert.equal(shouldPersistToken('rejected', fresh), false)
  })
}

for (const [name, value] of [['Undefined', undefined], ['Null', null], ['Empty', '']] as const) {
  test(`nextToken_NothingPersisted_GeneratesAndMarksPending_${name}`, () => {
    const r = nextTokenToPresent(value, value)
    assert.equal(r.isNew, true)
    assert.equal(r.shouldPersistPending, true)
    assert.match(r.token, /^[A-Za-z0-9_-]{43}$/)
  })
}

test('nextToken_NothingPersisted_GeneratesAndMarksPending', () => {
  const a = nextTokenToPresent(undefined, undefined)
  const b = nextTokenToPresent(undefined, undefined)
  assert.equal(a.isNew && a.shouldPersistPending, true)
  assert.notEqual(a.token, b.token)
})

test('nextToken_PendingExists_ReusesPending', () => {
  // Every later attempt presents the same token until the hub answers.
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(nextTokenToPresent(undefined, 'pending-tok'), { token: 'pending-tok', isNew: false, shouldPersistPending: false })
  }
})

test('nextToken_Persisted_UsesPersisted', () => {
  assert.deepEqual(nextTokenToPresent('stored-tok', 'pending-tok'), { token: 'stored-tok', isNew: false, shouldPersistPending: false })
})

test('afterLegacy_PendingNotPromoted', () => {
  assert.deepEqual(afterHandshake('legacy', false), { promote: false })
})

test('afterRejected_PendingNotPromoted', () => {
  assert.deepEqual(afterHandshake('rejected', false), { promote: false })
})

test('afterSecured_PendingPromoted', () => {
  assert.deepEqual(afterHandshake('secured', false), { promote: true })
})

test('afterSecured_PersistedToken_NothingToPromote', () => {
  assert.deepEqual(afterHandshake('secured', true), { promote: false })
})
