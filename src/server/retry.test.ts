import { test } from 'node:test'
import assert from 'node:assert/strict'
import { retryUntil } from './retry'

test('retryUntil_SucceedsFirstTry_NoSleep', async () => {
  const sleeps: number[] = []
  const r = await retryUntil(async () => 'ok', {
    delaysMs: [10, 20],
    isCancelled: () => false,
    sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.equal(r, 'ok')
  assert.deepEqual(sleeps, [])
})

test('retryUntil_FailsTwiceThenSucceeds_SleepsInOrder', async () => {
  const sleeps: number[] = []
  let n = 0
  const r = await retryUntil(async () => {
    if (++n < 3) throw new Error('down')
    return n
  }, { delaysMs: [10, 20, 30], isCancelled: () => false, sleep: async (ms) => { sleeps.push(ms) } })
  assert.equal(r, 3)
  assert.deepEqual(sleeps, [10, 20])
})

test('retryUntil_DelaysCapAtLastValue', async () => {
  const sleeps: number[] = []
  let n = 0
  await retryUntil(async () => {
    if (++n < 6) throw new Error('down')
    return n
  }, { delaysMs: [1, 2], isCancelled: () => false, sleep: async (ms) => { sleeps.push(ms) } })
  assert.deepEqual(sleeps, [1, 2, 2, 2, 2])
})

test('retryUntil_Cancelled_ReturnsUndefinedAndStops', async () => {
  let cancelled = false
  let calls = 0
  const r = await retryUntil(async () => {
    calls++
    throw new Error('down')
  }, { delaysMs: [1], isCancelled: () => cancelled, sleep: async () => { cancelled = true } })
  assert.equal(r, undefined)
  assert.equal(calls, 1)

  // Cancelled before the first attempt: nothing runs at all.
  const r2 = await retryUntil(async () => { calls++; return 1 }, { delaysMs: [1], isCancelled: () => true, sleep: async () => {} })
  assert.equal(r2, undefined)
  assert.equal(calls, 1)
})

test('retryUntil_OnErrorCalledPerFailure', async () => {
  const seen: Array<[string, number]> = []
  let n = 0
  await retryUntil(async () => {
    if (++n < 3) throw new Error(`e${n}`)
    return 1
  }, {
    delaysMs: [1],
    isCancelled: () => false,
    sleep: async () => {},
    onError: (err, i) => seen.push([(err as Error).message, i]),
  })
  assert.deepEqual(seen, [['e1', 1], ['e2', 2]])
})
