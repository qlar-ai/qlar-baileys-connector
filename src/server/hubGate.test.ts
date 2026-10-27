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

test('close_WithPendingWaiter_WaiterTimesOutFalse', async () => {
  const gate = new HubGate()
  const waiting = gate.wait(30)
  gate.close()
  assert.equal(await waiting, false)
})

test('wait_TimedOut_WaiterRemovedFromSet', async () => {
  const gate = new HubGate()
  await gate.wait(10)
  assert.equal((gate as unknown as { waiters: Set<unknown> }).waiters.size, 0)
})

test('open_CalledTwice_IsIdempotent', async () => {
  const gate = new HubGate()
  const waiting = gate.wait(1000)
  gate.open()
  gate.open()
  assert.equal(await waiting, true)
  assert.equal(await gate.wait(10), true)
})

test('isOpen_ReflectsState', () => {
  const gate = new HubGate()
  assert.equal(gate.isOpen, false)
  gate.open()
  assert.equal(gate.isOpen, true)
  gate.close()
  assert.equal(gate.isOpen, false)
})
