import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideReconnect } from './reconnectPolicy'

test('attempt0_Any_5000ms', () => {
  for (const code of [428, 500, 408, undefined]) {
    const d = decideReconnect(code, 0, () => 0.99)
    assert.equal(d.reconnect, true)
    assert.equal(d.delayMs, 5000)
  }
})

test('attempt1_10s_within_jitter', () => {
  assert.equal(decideReconnect(500, 1, () => 0.5).delayMs, 10000)
  assert.equal(decideReconnect(500, 1, () => 0).delayMs, 8000)
  assert.equal(decideReconnect(500, 1, () => 1).delayMs, 12000)
})

test('attempt10_CappedAt5min', () => {
  assert.equal(decideReconnect(500, 10, () => 0.5).delayMs, 300000)
  assert.ok(decideReconnect(500, 10, () => 1).delayMs <= 360000)
  assert.ok(decideReconnect(500, 10, () => 0).delayMs >= 240000)
})

for (const code of [440, 403, 411]) {
  test(`${code}_NoReconnect`, () => {
    const d = decideReconnect(code, 0)
    assert.equal(d.reconnect, false)
    assert.ok(d.reason.includes(String(code)))
  })
}

test('515_Attempt0_5000ms', () => {
  const d = decideReconnect(515, 0)
  assert.equal(d.reconnect, true)
  assert.equal(d.delayMs, 5000)
})

test('undefined_Reconnects', () => {
  assert.equal(decideReconnect(undefined, 3, () => 0.5).reconnect, true)
})

test('jitter_NeverNegative', () => {
  for (const r of [0, 0.5, 1]) {
    for (let a = 0; a < 15; a++) assert.ok(decideReconnect(500, a, () => r).delayMs >= 0)
  }
})
