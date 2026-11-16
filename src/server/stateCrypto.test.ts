import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'crypto'
import {
  describeKeyring,
  loadStateKeyring,
  open,
  seal,
  StateDecryptError,
  StateKeyConfigError,
  stateStartupWarning,
  unwrapDataKey,
  wrapDataKey,
} from './stateCrypto'

// Generated per run; never a real key.
const testKey = (): string => crypto.randomBytes(32).toString('base64')

test('loadStateKeyring_NoKey_PlaintextModeWithoutKeys', () => {
  const k = loadStateKeyring({})
  assert.equal(k.mode, 'plaintext')
  assert.equal(k.currentVersion, undefined)
  assert.equal(k.keys.size, 0)
})

test('loadStateKeyring_KeySet_EncryptsWithDefaultVersionV1', () => {
  const k = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })
  assert.equal(k.mode, 'encrypt')
  assert.equal(k.currentVersion, 'v1')
  assert.deepEqual([...k.keys.keys()], ['v1'])
})

test('loadStateKeyring_VersionAndOlderKeys_AllReadable_CaseInsensitive', () => {
  const k = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey(), CONNECTOR_STATE_KEY_VERSION: 'V2', CONNECTOR_STATE_KEY_V1: testKey() })
  assert.equal(k.currentVersion, 'v2')
  assert.deepEqual([...k.keys.keys()].sort(), ['v1', 'v2'])
})

test('loadStateKeyring_EmptyKeyValue_TreatedAsUnset', () => {
  assert.equal(loadStateKeyring({ CONNECTOR_STATE_KEY: '  ', CONNECTOR_STATE_KEY_V1: '' }).mode, 'plaintext')
})

for (const [name, value] of [
  ['NotBase64', 'not base64 !!'],
  ['WrongLength', crypto.randomBytes(16).toString('base64')],
] as const) {
  test(`loadStateKeyring_${name}_ThrowsWithoutEchoingTheValue`, () => {
    assert.throws(() => loadStateKeyring({ CONNECTOR_STATE_KEY: value }), (err: Error) => {
      assert.ok(err instanceof StateKeyConfigError)
      assert.ok(!err.message.includes(value))
      return true
    })
  })
}

test('loadStateKeyring_CurrentAndSameVersionVariableDisagree_Throws', () => {
  assert.throws(() => loadStateKeyring({ CONNECTOR_STATE_KEY: testKey(), CONNECTOR_STATE_KEY_V1: testKey() }), StateKeyConfigError)
})

test('loadStateKeyring_ReservedOrInvalidVersion_Throws', () => {
  assert.throws(() => loadStateKeyring({ CONNECTOR_STATE_KEY: testKey(), CONNECTOR_STATE_KEY_VERSION: 'dek' }), StateKeyConfigError)
  assert.throws(() => loadStateKeyring({ CONNECTOR_STATE_KEY: testKey(), CONNECTOR_STATE_KEY_VERSION: 'v:1' }), StateKeyConfigError)
})

test('loadStateKeyring_Modes', () => {
  assert.throws(() => loadStateKeyring({ CONNECTOR_STATE_MODE: 'encrypt' }), StateKeyConfigError)
  assert.throws(() => loadStateKeyring({ CONNECTOR_STATE_MODE: 'decrypt' }), StateKeyConfigError)
  assert.throws(() => loadStateKeyring({ CONNECTOR_STATE_MODE: 'off', CONNECTOR_STATE_KEY: testKey() }), StateKeyConfigError)
  assert.equal(loadStateKeyring({ CONNECTOR_STATE_MODE: 'decrypt', CONNECTOR_STATE_KEY: testKey() }).mode, 'decrypt')
  // Decrypt only needs a key that can read; an older version alone is enough.
  assert.equal(loadStateKeyring({ CONNECTOR_STATE_MODE: 'decrypt', CONNECTOR_STATE_KEY_V1: testKey() }).mode, 'decrypt')
})

test('describeKeyring_NeverContainsKeyMaterial', () => {
  const key = testKey()
  const text = JSON.stringify(describeKeyring(loadStateKeyring({ CONNECTOR_STATE_KEY: key })))
  assert.ok(!text.includes(key))
  assert.ok(!text.includes(Buffer.from(key, 'base64').toString('hex')))
  assert.match(text, /"mode":"encrypt"/)
})

test('stateStartupWarning_NoKey_Warns_KeySet_Silent', () => {
  assert.match(stateStartupWarning(loadStateKeyring({}), '/state') ?? '', /CONNECTOR_STATE_KEY is not set.*UNENCRYPTED/)
  assert.equal(stateStartupWarning(loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() }), '/state'), undefined)
  assert.match(stateStartupWarning(loadStateKeyring({ CONNECTOR_STATE_KEY: testKey(), CONNECTOR_STATE_MODE: 'decrypt' }), '/state') ?? '', /decrypt/)
})

test('sealOpen_Roundtrip_EnvelopeShape', () => {
  const key = crypto.randomBytes(32)
  const env = seal(key, 'dek', Buffer.from('{"a":1}'), 's1/creds.json')
  assert.match(env, /^qlarenc1:dek:[A-Za-z0-9+/=]+$/)
  assert.ok(!env.includes('"a"'))
  assert.equal(open(key, env, 's1/creds.json').toString(), '{"a":1}')
  // Fresh IV each time.
  assert.notEqual(seal(key, 'dek', Buffer.from('x'), 'a'), seal(key, 'dek', Buffer.from('x'), 'a'))
})

test('open_OtherAad_WrongKey_Tampered_AllRejected', () => {
  const key = crypto.randomBytes(32)
  const env = seal(key, 'dek', Buffer.from('secret'), 's1/creds.json')
  assert.throws(() => open(key, env, 's2/creds.json'), StateDecryptError)
  assert.throws(() => open(crypto.randomBytes(32), env, 's1/creds.json'), StateDecryptError)
  const raw = Buffer.from(env.slice('qlarenc1:dek:'.length), 'base64')
  raw[raw.length - 20] ^= 1
  assert.throws(() => open(key, `qlarenc1:dek:${raw.toString('base64')}`, 's1/creds.json'), StateDecryptError)
  assert.throws(() => open(key, 'qlarenc1:dek:AAAA', 's1/creds.json'), StateDecryptError)
})

test('wrapUnwrap_OlderVersionStillUnwraps_UnknownVersionFails', () => {
  const v1 = testKey()
  const old = loadStateKeyring({ CONNECTOR_STATE_KEY: v1 })
  const dek = crypto.randomBytes(32)
  const wrapped = wrapDataKey(old, dek, 's/state.key')
  assert.match(wrapped, /^qlarenc1:v1:/)

  const rotated = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey(), CONNECTOR_STATE_KEY_VERSION: 'v2', CONNECTOR_STATE_KEY_V1: v1 })
  const back = unwrapDataKey(rotated, wrapped, 's/state.key')
  assert.equal(back.version, 'v1')
  assert.ok(back.dek.equals(dek))

  const onlyNew = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey(), CONNECTOR_STATE_KEY_VERSION: 'v2' })
  assert.throws(() => unwrapDataKey(onlyNew, wrapped, 's/state.key'), /v1, which is not configured/)
})
