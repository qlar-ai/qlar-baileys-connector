import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AuthStateDeps, useEncryptedMultiFileAuthState } from './encryptedAuthState'
import { loadStateKeyring } from './stateCrypto'
import { KEY_FILE, prepareSessionState } from './sessionState'

// Stand-ins for the three Baileys exports (Baileys is ESM-only and does not load under tsx).
// BufferJSON mirrors Baileys': Buffers travel as { type: 'Buffer', data: <base64> }.
const BufferJSON: AuthStateDeps['BufferJSON'] = {
  replacer: (_k, value) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
      return { type: 'Buffer', data: Buffer.from(value?.data || value).toString('base64') }
    }
    return value
  },
  reviver: (_k, value) => {
    if (value && typeof value === 'object' && value.type === 'Buffer' && typeof value.data === 'string') {
      return Buffer.from(value.data, 'base64')
    }
    return value
  },
}
const fromObjectCalls: unknown[] = []
const deps: AuthStateDeps = {
  initAuthCreds: () => ({ fresh: true, noiseKey: { private: crypto.randomBytes(32) }, registrationId: 42 }),
  BufferJSON,
  proto: { Message: { AppStateSyncKeyData: { fromObject: (v: any) => { fromObjectCalls.push(v); return { wrapped: v } } } } },
}

const testKey = (): string => crypto.randomBytes(32).toString('base64')

function sessionDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-'))
  const dir = path.join(root, `sess-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(dir)
  return dir
}

const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, 'wa_session', name), 'utf-8')

test('encrypt_FreshSession_RoundtripCredsAndKeys_AllFilesEncrypted', async () => {
  const dir = sessionDir()
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })

  const first = await useEncryptedMultiFileAuthState(dir, { deps, keyring })
  assert.equal(first.state.creds.fresh, true)
  first.state.creds.me = { id: '628:1@s.whatsapp.net' }
  await first.saveCreds()
  const preKey = { private: crypto.randomBytes(32), public: crypto.randomBytes(32) }
  await first.state.keys.set({ 'pre-key': { '1': preKey }, 'app-state-sync-key': { 'AAA/b:c': { keyData: 'x' } } })

  assert.match(read(dir, 'creds.json'), /^qlarenc1:dek:/)
  assert.match(read(dir, 'pre-key-1.json'), /^qlarenc1:dek:/)
  // Baileys' file-name rules are kept.
  assert.match(read(dir, 'app-state-sync-key-AAA__b-c.json'), /^qlarenc1:dek:/)
  assert.ok(fs.existsSync(path.join(dir, KEY_FILE)))
  assert.ok(!fs.readdirSync(path.join(dir, 'wa_session')).some((f) => f.endsWith('.qlartmp')))

  const second = await useEncryptedMultiFileAuthState(dir, { deps, keyring })
  assert.deepEqual(second.state.creds.me, { id: '628:1@s.whatsapp.net' })
  assert.ok(Buffer.isBuffer(second.state.creds.noiseKey.private))
  const got = await second.state.keys.get('pre-key', ['1', '2'])
  assert.ok(got['1'].private.equals(preKey.private))
  assert.equal(got['2'], null)
  const sync = await second.state.keys.get('app-state-sync-key', ['AAA/b:c'])
  assert.deepEqual(sync['AAA/b:c'], { wrapped: { keyData: 'x' } })

  await second.state.keys.set({ 'pre-key': { '1': null } })
  assert.ok(!fs.existsSync(path.join(dir, 'wa_session', 'pre-key-1.json')))
})

test('encrypt_LegacyPlaintextFiles_StillRead_NewWritesEncrypted', async () => {
  const dir = sessionDir()
  fs.mkdirSync(path.join(dir, 'wa_session'))
  fs.writeFileSync(path.join(dir, 'wa_session', 'creds.json'), JSON.stringify({ me: { id: 'legacy' }, k: crypto.randomBytes(4) }, BufferJSON.replacer))
  fs.writeFileSync(path.join(dir, 'wa_session', 'session-1.json'), JSON.stringify({ s: 1 }))
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })

  const auth = await useEncryptedMultiFileAuthState(dir, { deps, keyring })
  assert.equal(auth.state.creds.me.id, 'legacy')
  assert.ok(Buffer.isBuffer(auth.state.creds.k))
  assert.deepEqual((await auth.state.keys.get('session', ['1']))['1'], { s: 1 })
  await auth.saveCreds()
  assert.match(read(dir, 'creds.json'), /^qlarenc1:dek:/)
})

test('plaintext_NoKey_WritesBaileysCompatibleJson_NoKeyFile', async () => {
  const dir = sessionDir()
  const auth = await useEncryptedMultiFileAuthState(dir, { deps, keyring: loadStateKeyring({}) })
  await auth.saveCreds()
  await auth.state.keys.set({ 'pre-key': { '5': { a: Buffer.from([1, 2]) } } })
  assert.deepEqual(JSON.parse(read(dir, 'creds.json'), BufferJSON.reviver).registrationId, 42)
  assert.equal(read(dir, 'pre-key-5.json'), JSON.stringify({ a: Buffer.from([1, 2]) }, BufferJSON.replacer))
  assert.ok(!fs.existsSync(path.join(dir, KEY_FILE)))
})

test('wrongKey_DoesNotStart_NeverReplacesCreds', async () => {
  const dir = sessionDir()
  const auth = await useEncryptedMultiFileAuthState(dir, { deps, keyring: loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() }) })
  auth.state.creds.me = { id: 'real' }
  await auth.saveCreds()
  const credsBefore = read(dir, 'creds.json')
  const keyBefore = fs.readFileSync(path.join(dir, KEY_FILE), 'utf-8')

  await assert.rejects(useEncryptedMultiFileAuthState(dir, { deps, keyring: loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() }) }))
  await assert.rejects(useEncryptedMultiFileAuthState(dir, { deps, keyring: loadStateKeyring({}) }))

  assert.equal(read(dir, 'creds.json'), credsBefore)
  assert.equal(fs.readFileSync(path.join(dir, KEY_FILE), 'utf-8'), keyBefore)
})

test('undecryptableCreds_Throws_InsteadOfFreshCreds', async () => {
  const dir = sessionDir()
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })
  const auth = await useEncryptedMultiFileAuthState(dir, { deps, keyring })
  await auth.saveCreds()
  // Same key, but creds.json taken from somewhere else (a different session's DEK).
  const other = sessionDir()
  const otherAuth = await useEncryptedMultiFileAuthState(other, { deps, keyring })
  await otherAuth.saveCreds()
  fs.copyFileSync(path.join(other, 'wa_session', 'creds.json'), path.join(dir, 'wa_session', 'creds.json'))
  const swapped = read(dir, 'creds.json')

  await assert.rejects(useEncryptedMultiFileAuthState(dir, { deps, keyring }), /does not open/)
  assert.equal(read(dir, 'creds.json'), swapped)
})

test('decryptMode_ReadsEncrypted_WritesPlaintext', async () => {
  const key = testKey()
  const dir = sessionDir()
  const enc = await useEncryptedMultiFileAuthState(dir, { deps, keyring: loadStateKeyring({ CONNECTOR_STATE_KEY: key }) })
  enc.state.creds.me = { id: 'x' }
  await enc.saveCreds()

  const decrypt = loadStateKeyring({ CONNECTOR_STATE_KEY: key, CONNECTOR_STATE_MODE: 'decrypt' })
  const dec = await useEncryptedMultiFileAuthState(dir, { deps, keyring: decrypt })
  assert.equal(dec.state.creds.me.id, 'x')
  await dec.state.keys.set({ 'pre-key': { '3': { p: 1 } } })
  assert.equal(read(dir, 'pre-key-3.json'), '{"p":1}')
  // Converting the rest makes the folder readable by a connector from before encryption.
  assert.ok((await prepareSessionState(dir, decrypt)).ok)
  assert.equal(JSON.parse(read(dir, 'creds.json')).me.id, 'x')
})

test('concurrentWritesSameFile_LastWriteWins_NoTornFile', async () => {
  const dir = sessionDir()
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })
  const auth = await useEncryptedMultiFileAuthState(dir, { deps, keyring })
  await Promise.all(Array.from({ length: 20 }, (_, i) => auth.state.keys.set({ session: { a: { n: i } } })))
  const again = await useEncryptedMultiFileAuthState(dir, { deps, keyring })
  assert.deepEqual((await again.state.keys.get('session', ['a'])).a, { n: 19 })
})
