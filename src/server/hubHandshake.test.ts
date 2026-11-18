import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  afterHandshake,
  classifyHubError,
  newConnectorToken,
  nextTokenToPresent,
  registerWithHub,
  SECURE_AFTER_PAIR_DELAYS_MS,
  secureAfterPair,
  shouldPersistToken,
} from './hubHandshake'

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

const SECURE_REQUIRED = "An unexpected error occurred invoking 'Connected' on the server. HubException: This session requires a secure reconnect. Update the connector."
const UNAVAILABLE = "An unexpected error occurred invoking 'ReconnectSecure' on the server. HubException: Connector authentication is temporarily unavailable. Try again shortly."

/** Records sleeps instead of waiting, so the backoff is visible and the tests run instantly. */
function fakeSleep() {
  const slept: number[] = []
  return { slept, sleep: async (ms: number) => { slept.push(ms) } }
}

test('secureAfterPair_OtherError_RetriesThenFails_HandsTokenBack', async () => {
  const boom = new Error('connection lost')
  const conn = fakeConn(async () => {
    throw boom
  })
  const { sleep } = fakeSleep()
  const result = await secureAfterPair(conn, 'sess-1', { sleep })
  assert.equal(result.outcome, 'failed')
  assert.ok(result.outcome === 'failed' && result.error === boom)
  assert.ok(result.outcome === 'failed' && result.attempts === SECURE_AFTER_PAIR_DELAYS_MS.length + 1)
  // The token is handed back so it can be kept as pending: the server may have stored it before the failure.
  assert.ok(result.outcome === 'failed' && result.token === conn.calls[0].args[1])
  assert.ok(conn.calls.every((c) => c.method === 'ReconnectSecure' && c.args[1] === conn.calls[0].args[1]))
})

test('secureAfterPair_TransientThenAccepted_RetriesWithSameToken', async () => {
  let n = 0
  const conn = fakeConn(async () => {
    n++
    if (n <= 2) throw new Error(UNAVAILABLE)
    return undefined
  })
  const { slept, sleep } = fakeSleep()
  const retries: number[] = []
  const result = await secureAfterPair(conn, 'sess-1', { sleep, onRetry: (_err, attempt) => retries.push(attempt) })
  assert.equal(result.outcome, 'secured')
  assert.equal(conn.calls.length, 3)
  // The same token every time: the server may have stored the first one before its reply was lost.
  const tokens = new Set(conn.calls.map((c) => c.args[1]))
  assert.equal(tokens.size, 1)
  assert.ok(result.outcome === 'secured' && tokens.has(result.token))
  assert.deepEqual(conn.calls.map((c) => c.method), ['ReconnectSecure', 'ReconnectSecure', 'ReconnectSecure'])
  assert.deepEqual(slept, SECURE_AFTER_PAIR_DELAYS_MS.slice(0, 2))
  assert.deepEqual(retries, [1, 2])
})

test('secureAfterPair_UsesGivenToken', async () => {
  const conn = fakeConn(async () => undefined)
  const result = await secureAfterPair(conn, 'sess-1', { token: 'given-tok' })
  assert.deepEqual(result, { outcome: 'secured', token: 'given-tok' })
  assert.deepEqual(conn.calls, [{ method: 'ReconnectSecure', args: ['sess-1', 'given-tok'] }])
})

test('secureAfterPair_TransientEveryTime_FailsAfterBoundedAttempts_KeepsToken', async () => {
  const boom = new Error(UNAVAILABLE)
  const conn = fakeConn(async () => {
    throw boom
  })
  const { slept, sleep } = fakeSleep()
  const result = await secureAfterPair(conn, 'sess-1', { token: 'tok-1', delaysMs: [10, 20, 30], sleep })
  assert.deepEqual(result, { outcome: 'failed', error: boom, token: 'tok-1', attempts: 4 })
  // Bounded: one attempt per delay plus the first, and no sleep after the last attempt.
  assert.equal(conn.calls.length, 4)
  assert.deepEqual(slept, [10, 20, 30])
  assert.ok(conn.calls.every((c) => c.method === 'ReconnectSecure' && c.args[1] === 'tok-1'))
})

test('secureAfterPair_ConnectionGoneDuringBackoff_StopsRetrying', async () => {
  const conn = fakeConn(async () => {
    throw new Error('connection lost')
  })
  const slept: number[] = []
  let usable = true
  const result = await secureAfterPair(conn, 'sess-1', {
    token: 'tok-1',
    sleep: async (ms) => {
      slept.push(ms)
      usable = false
    },
    isCancelled: () => !usable,
  })
  assert.equal(result.outcome, 'failed')
  assert.ok(result.outcome === 'failed' && result.attempts === 1 && result.token === 'tok-1')
  assert.equal(conn.calls.length, 1)
  assert.equal(slept.length, 1)
})

test('secureAfterPair_CancelledAfterFirstAttempt_NoSleep', async () => {
  const conn = fakeConn(async () => {
    throw new Error(UNAVAILABLE)
  })
  const { slept, sleep } = fakeSleep()
  const result = await secureAfterPair(conn, 'sess-1', { sleep, isCancelled: () => true })
  // The first attempt always runs (Pair just succeeded on this connection); a cancelled one never sleeps.
  assert.equal(result.outcome, 'failed')
  assert.equal(conn.calls.length, 1)
  assert.deepEqual(slept, [])
})

test('secureAfterPair_TransientThenRejected_ReturnsRejected', async () => {
  let n = 0
  const conn = fakeConn(async () => {
    n++
    if (n === 1) throw new Error(UNAVAILABLE)
    throw new Error('HubException: Connector token rejected.')
  })
  const { sleep } = fakeSleep()
  assert.deepEqual(await secureAfterPair(conn, 'sess-1', { sleep }), { outcome: 'rejected' })
  assert.equal(conn.calls.length, 2)
})

test('secureAfterPair_SecureReconnectRequired_FinalNoRetry', async () => {
  const conn = fakeConn(async () => {
    throw new Error(SECURE_REQUIRED)
  })
  const { slept, sleep } = fakeSleep()
  assert.deepEqual(await secureAfterPair(conn, 'sess-1', { sleep }), { outcome: 'secure-required' })
  assert.equal(conn.calls.length, 1)
  assert.deepEqual(slept, [])
})

test('secureAfterPair_OldServer_NeverRetried', async () => {
  const conn = fakeConn(async () => {
    throw new Error('HubException: Method does not exist.')
  })
  const { slept, sleep } = fakeSleep()
  assert.deepEqual(await secureAfterPair(conn, 'sess-1', { sleep }), { outcome: 'unsecured', reason: 'old-server' })
  assert.equal(conn.calls.length, 1)
  assert.deepEqual(slept, [])
})

test('registerWithHub_SecureReconnectRequired_ReturnsSecureRequired_NoFallback', async () => {
  const conn = fakeConn(async () => {
    throw new Error(SECURE_REQUIRED)
  })
  assert.equal(await registerWithHub(conn, 'sess-1', 'tok-1'), 'secure-required')
  // Final: never retried through the legacy Reconnect.
  assert.deepEqual(conn.calls.map((c) => c.method), ['ReconnectSecure'])
})

test('registerWithHub_LegacyReconnectRefusedAsSecureRequired_ReturnsSecureRequired', async () => {
  const conn = fakeConn(async (method) => {
    if (method === 'ReconnectSecure') throw new Error('HubException: Method does not exist.')
    throw new Error(SECURE_REQUIRED)
  })
  assert.equal(await registerWithHub(conn, 'sess-1', 'tok-1'), 'secure-required')
  assert.deepEqual(conn.calls.map((c) => c.method), ['ReconnectSecure', 'Reconnect'])
})

test('registerWithHub_AuthUnavailable_Rethrows_ForTheCallerToRetry', async () => {
  const conn = fakeConn(async () => {
    throw new Error(UNAVAILABLE)
  })
  await assert.rejects(registerWithHub(conn, 'sess-1', 'tok-1'), /temporarily unavailable/)
  assert.equal(conn.calls.length, 1)
})

for (const [message, expected] of [
  ['HubException: Connector token rejected.', 'rejected'],
  [SECURE_REQUIRED, 'secure-required'],
  ["Failed to invoke 'ReconnectSecure' due to an error on the server. HubException: Method does not exist.", 'old-server'],
  [UNAVAILABLE, 'transient'],
  ['connection lost', 'transient'],
  ['HubException: Messenger account not found.', 'transient'],
] as const) {
  test(`classifyHubError_${expected}_${message.slice(0, 40)}`, () => {
    assert.equal(classifyHubError(new Error(message)), expected)
    assert.equal(classifyHubError(message), expected)
  })
}

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
