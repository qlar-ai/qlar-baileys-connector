import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HubGate } from './hubGate'

test('wait_WhenOpen_ResolvesTrueImmediately', async () => {
  const gate = new HubGate()
  gate.open()
  assert.equal(await gate.wait(1000), true)
})

test('wait_ClosedThenOpened_ResolvesTrue', async () => {
  const gate = new HubGate()
  const waiting = gate.wait(5000)
  setTimeout(() => gate.open(), 10)
  assert.equal(await waiting, true)
})

test('wait_Timeout_ResolvesFalse', async () => {
  const gate = new HubGate()
  assert.equal(await gate.wait(20), false)
})

test('close_AfterOpen_BlocksNextWait', async () => {
  const gate = new HubGate()
  gate.open()
  gate.close()
  assert.equal(await gate.wait(20), false)
})

test('wait_ManyWaiters_AllReleasedOnOpen', async () => {
  const gate = new HubGate()
  const waiters = [gate.wait(5000), gate.wait(5000), gate.wait(5000)]
  gate.open()
  assert.deepEqual(await Promise.all(waiters), [true, true, true])
})
