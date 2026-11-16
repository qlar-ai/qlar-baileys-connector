import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loadStateKeyring, StateKeyring } from './stateCrypto'
import { isLinked, KEY_FILE, prepareSessionState, readMeta, SessionStateCipher, StateLog, writeMeta } from './sessionState'

const testKey = (): string => crypto.randomBytes(32).toString('base64')
const plain = loadStateKeyring({})

function memoryLog() {
  const lines: { level: string; msg: string; obj: object }[] = []
  const log: StateLog = {
    info: (obj, msg) => lines.push({ level: 'info', msg, obj }),
    warn: (obj, msg) => lines.push({ level: 'warn', msg, obj }),
    error: (obj, msg) => lines.push({ level: 'error', msg, obj }),
  }
  return { log, lines }
}

const CREDS = JSON.stringify({ me: { id: '628123:1@s.whatsapp.net' }, noiseKey: { private: { type: 'Buffer', data: 'AAEC' } } })
const PREKEY = JSON.stringify({ private: { type: 'Buffer', data: 'BBBB' }, public: { type: 'Buffer', data: 'CCCC' } })
const SESSION = JSON.stringify({ _sessions: { abc: { registrationId: 7 } } })

/** A legacy (plaintext) session as written by every connector before this change. */
function legacySession(opts: { linked?: boolean; tokens?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-'))
  const sessionId = `sess-${crypto.randomBytes(4).toString('hex')}`
  const dir = path.join(root, sessionId)
  const wa = path.join(dir, 'wa_session')
  fs.mkdirSync(wa, { recursive: true })
  fs.writeFileSync(path.join(wa, 'creds.json'), opts.linked === false ? JSON.stringify({ noiseKey: {} }) : CREDS)
  fs.writeFileSync(path.join(wa, 'pre-key-1.json'), PREKEY)
  fs.writeFileSync(path.join(wa, 'pre-key-2.json'), PREKEY.replace('BBBB', 'DDDD'))
  fs.writeFileSync(path.join(wa, 'session-628999.0.json'), SESSION)
  const meta: Record<string, unknown> = { sessionId, agentId: 'agent-1', hubUrl: 'https://hub' }
  if (opts.tokens !== false) {
    meta.connectorToken = 'tok-confirmed-123'
    meta.pendingConnectorToken = 'tok-pending-456'
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  return { root, dir, wa, sessionId }
}

/** Every file under `dir` with its bytes, for "nothing changed" assertions. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf-8')
    }
  }
  walk(dir)
  return out
}

const waFiles = (wa: string) => fs.readdirSync(wa).sort()

async function encrypted(keyring: StateKeyring, opts?: { linked?: boolean; tokens?: boolean }) {
  const s = legacySession(opts)
  const result = await prepareSessionState(s.dir, keyring)
  assert.ok(result.ok)
  return s
}

test('cipher_EncodeDecodeFile_Roundtrip', () => {
  const s = legacySession()
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })
  const cipher = SessionStateCipher.forSession(s.dir, keyring)
  const stored = cipher.encodeFile('creds.json', CREDS)
  assert.match(stored, /^qlarenc1:dek:/)
  assert.ok(!stored.includes('s.whatsapp.net'))
  assert.equal(cipher.decodeFile('creds.json', stored), CREDS)
  // A plaintext (legacy) value always reads as is.
  assert.equal(cipher.decodeFile('creds.json', CREDS), CREDS)
  // The session key file is the wrapped DEK, never the KEK.
  assert.match(fs.readFileSync(path.join(s.dir, KEY_FILE), 'utf-8'), /^qlarenc1:v1:/)
})

test('prepare_Encrypt_ConvertsEveryFileAndTokens_ContentPreserved', async () => {
  const s = legacySession()
  const before = snapshot(s.wa)
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })

  const result = await prepareSessionState(s.dir, keyring)

  assert.deepEqual(result, { ok: true, converted: 6, failed: 0 })
  assert.deepEqual(waFiles(s.wa), Object.keys(before).sort(), 'no file added or lost, no temp file left')
  const cipher = SessionStateCipher.forSession(s.dir, keyring)
  for (const [name, content] of Object.entries(before)) {
    const stored = fs.readFileSync(path.join(s.wa, name), 'utf-8')
    assert.match(stored, /^qlarenc1:dek:/, name)
    assert.equal(cipher.decodeFile(name, stored), content, name)
  }
  const rawMeta = JSON.parse(fs.readFileSync(path.join(s.dir, 'meta.json'), 'utf-8'))
  assert.match(rawMeta.connectorToken, /^qlarenc1:dek:/)
  assert.match(rawMeta.pendingConnectorToken, /^qlarenc1:dek:/)
  assert.equal(rawMeta.agentId, 'agent-1')
  const meta = readMeta(s.dir, keyring)
  assert.equal(meta.connectorToken, 'tok-confirmed-123')
  assert.equal(meta.pendingConnectorToken, 'tok-pending-456')
})

test('prepare_Encrypt_Idempotent_SecondRunChangesNothing', async () => {
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })
  const s = await encrypted(keyring)
  const after1 = snapshot(s.dir)
  const result = await prepareSessionState(s.dir, keyring)
  assert.deepEqual(result, { ok: true, converted: 0, failed: 0 })
  assert.deepEqual(snapshot(s.dir), after1)
})

test('prepare_Encrypt_PartiallyConvertedSession_FinishesTheRest', async () => {
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })
  const s = await encrypted(keyring)
  // A plaintext file appearing later (e.g. written by an older version) is converted on the next start.
  fs.writeFileSync(path.join(s.wa, 'sender-key-x.json'), '{"k":1}')
  const result = await prepareSessionState(s.dir, keyring)
  assert.deepEqual(result, { ok: true, converted: 1, failed: 0 })
  assert.match(fs.readFileSync(path.join(s.wa, 'sender-key-x.json'), 'utf-8'), /^qlarenc1:dek:/)
})

test('aad_FileRenamedOrMovedToAnotherSession_DoesNotDecrypt', async () => {
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })
  const a = await encrypted(keyring)
  const cipherA = SessionStateCipher.forSession(a.dir, keyring)
  const preKey1 = fs.readFileSync(path.join(a.wa, 'pre-key-1.json'), 'utf-8')
  // Same session, same key, other file name.
  assert.throws(() => cipherA.decodeFile('pre-key-2.json', preKey1), /does not open/)

  // Another session: copying its state.key along does not help, the session id is bound in.
  const b = await encrypted(keyring)
  fs.copyFileSync(path.join(a.dir, KEY_FILE), path.join(b.dir, KEY_FILE))
  assert.throws(() => SessionStateCipher.forSession(b.dir, keyring), /does not open/)
  // And a token field cannot be swapped into the other field.
  const raw = JSON.parse(fs.readFileSync(path.join(a.dir, 'meta.json'), 'utf-8'))
  assert.throws(() => cipherA.decodeField('connectorToken', raw.pendingConnectorToken), /does not open/)
})

test('prepare_WrongKey_RefusesAndLeavesEveryFileUntouched', async () => {
  const s = await encrypted(loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() }))
  const before = snapshot(s.dir)
  const { log, lines } = memoryLog()

  const result = await prepareSessionState(s.dir, loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() }), log)

  assert.equal(result.ok, false)
  assert.deepEqual(snapshot(s.dir), before)
  assert.ok(lines.some((l) => l.level === 'error'))
  // Logs never carry token values.
  assert.ok(!JSON.stringify(lines).includes('tok-'))
})

test('prepare_UnknownKeyVersion_RefusesAndLeavesEveryFileUntouched', async () => {
  const s = await encrypted(loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() }))
  const before = snapshot(s.dir)
  const result = await prepareSessionState(s.dir, loadStateKeyring({ CONNECTOR_STATE_KEY: testKey(), CONNECTOR_STATE_KEY_VERSION: 'v2' }))
  assert.equal(result.ok, false)
  assert.deepEqual(snapshot(s.dir), before)
})

test('prepare_StateKeyDeletedButFilesEncrypted_RefusesAndKeepsFiles', async () => {
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })
  const s = await encrypted(keyring)
  fs.rmSync(path.join(s.dir, KEY_FILE))
  const before = snapshot(s.dir)
  const result = await prepareSessionState(s.dir, keyring)
  assert.equal(result.ok, false)
  assert.deepEqual(snapshot(s.dir), before, 'no new state.key minted over encrypted files')
})

test('prepare_NoKey_EncryptedSession_RefusesAndLeavesFilesUntouched', async () => {
  const s = await encrypted(loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() }))
  const before = snapshot(s.dir)
  const { log, lines } = memoryLog()
  const result = await prepareSessionState(s.dir, plain, log)
  assert.equal(result.ok, false)
  assert.deepEqual(snapshot(s.dir), before)
  assert.ok(lines.some((l) => l.level === 'error' && /CONNECTOR_STATE_KEY is not set/.test(JSON.stringify(l.obj))))
})

test('prepare_NoKey_PlaintextSession_KeptPlaintext_NoKeyFile', async () => {
  const s = legacySession()
  const before = snapshot(s.dir)
  const result = await prepareSessionState(s.dir, plain)
  assert.deepEqual(result, { ok: true, converted: 0, failed: 0 })
  assert.deepEqual(snapshot(s.dir), before)
  // And writes stay plaintext.
  writeMeta(s.dir, { ...readMeta(s.dir, plain), connectorToken: 'tok-new' }, plain)
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'meta.json'), 'utf-8')).connectorToken, 'tok-new')
  assert.ok(!fs.existsSync(path.join(s.dir, KEY_FILE)))
})

test('prepare_DecryptMode_RestoresOriginalPlaintextAndRemovesStateKey', async () => {
  const key = testKey()
  const s = legacySession()
  const original = snapshot(s.dir)
  assert.ok((await prepareSessionState(s.dir, loadStateKeyring({ CONNECTOR_STATE_KEY: key }))).ok)

  const result = await prepareSessionState(s.dir, loadStateKeyring({ CONNECTOR_STATE_KEY: key, CONNECTOR_STATE_MODE: 'decrypt' }))

  assert.deepEqual(result, { ok: true, converted: 6, failed: 0 })
  const after = snapshot(s.dir)
  // Auth files are byte-identical to what the old connector wrote; meta.json has the same fields.
  for (const name of Object.keys(original).filter((n) => n.startsWith('wa_session'))) assert.equal(after[name], original[name], name)
  assert.deepEqual(JSON.parse(after['meta.json']), JSON.parse(original['meta.json']))
  assert.ok(!fs.existsSync(path.join(s.dir, KEY_FILE)))
  // What an older connector reads: plain JSON.
  assert.equal(isLinked(s.dir, plain), true)
})

test('decryptMode_WritesPlaintext', async () => {
  const key = testKey()
  const s = await encrypted(loadStateKeyring({ CONNECTOR_STATE_KEY: key }))
  const decrypt = loadStateKeyring({ CONNECTOR_STATE_KEY: key, CONNECTOR_STATE_MODE: 'decrypt' })
  const cipher = SessionStateCipher.forSession(s.dir, decrypt)
  assert.equal(cipher.writesEncrypted, false)
  assert.equal(cipher.encodeFile('creds.json', CREDS), CREDS)
  writeMeta(s.dir, { sessionId: s.sessionId, agentId: 'a', hubUrl: 'h', connectorToken: 'tok-x' }, decrypt)
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.dir, 'meta.json'), 'utf-8')).connectorToken, 'tok-x')
})

test('isLinked_BothFormats', async () => {
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })
  assert.equal(isLinked(legacySession().dir, plain), true)
  assert.equal(isLinked(legacySession({ linked: false }).dir, plain), false)
  assert.equal(isLinked((await encrypted(keyring)).dir, keyring), true)
  assert.equal(isLinked((await encrypted(keyring, { linked: false })).dir, keyring), false)
  const noCreds = legacySession()
  fs.rmSync(path.join(noCreds.wa, 'creds.json'))
  assert.equal(isLinked(noCreds.dir, keyring), false)
})

test('isLinked_EncryptedButKeyMissingOrWrong_CountsAsLinked_NeverWipeBait', async () => {
  const s = await encrypted(loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() }), { linked: false })
  assert.equal(isLinked(s.dir, plain), true)
  assert.equal(isLinked(s.dir, loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })), true)
})

test('rotation_OldVersionStillReads_PrepareRewrapsToCurrent_ThenOldKeyNotNeeded', async () => {
  const v1 = testKey()
  const v2 = testKey()
  const s = await encrypted(loadStateKeyring({ CONNECTOR_STATE_KEY: v1 }))
  const filesBefore = snapshot(s.wa)
  const rotated = loadStateKeyring({ CONNECTOR_STATE_KEY: v2, CONNECTOR_STATE_KEY_VERSION: 'v2', CONNECTOR_STATE_KEY_V1: v1 })

  // Reading works with the old version before anything is rewrapped.
  assert.equal(readMeta(s.dir, rotated).connectorToken, 'tok-confirmed-123')
  assert.equal(isLinked(s.dir, rotated), true)

  const result = await prepareSessionState(s.dir, rotated)
  assert.ok(result.ok)
  assert.match(fs.readFileSync(path.join(s.dir, KEY_FILE), 'utf-8'), /^qlarenc1:v2:/)
  // Only the wrapped key changed; data files are untouched.
  assert.deepEqual(snapshot(s.wa), filesBefore)

  const onlyV2 = loadStateKeyring({ CONNECTOR_STATE_KEY: v2, CONNECTOR_STATE_KEY_VERSION: 'v2' })
  assert.ok((await prepareSessionState(s.dir, onlyV2)).ok)
  assert.equal(readMeta(s.dir, onlyV2).pendingConnectorToken, 'tok-pending-456')
})

test('prepare_CorruptStateKeyWithNothingEncrypted_IsReplaced', async () => {
  const s = legacySession()
  fs.writeFileSync(path.join(s.dir, KEY_FILE), 'qlarenc1:v1:trunc')
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })
  const result = await prepareSessionState(s.dir, keyring)
  assert.ok(result.ok)
  assert.equal(readMeta(s.dir, keyring).connectorToken, 'tok-confirmed-123')
})

test('prepare_StaleTempFiles_Removed_OriginalsKept', async () => {
  const s = legacySession()
  fs.writeFileSync(path.join(s.wa, 'creds.json.123.4.qlartmp'), 'half')
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })
  assert.ok((await prepareSessionState(s.dir, keyring)).ok)
  assert.ok(!fs.readdirSync(s.wa).some((f) => f.endsWith('.qlartmp')))
  assert.equal(isLinked(s.dir, keyring), true)
})

test('prepare_OneCorruptEnvelope_LoggedAndLeft_SessionStillStarts', async () => {
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })
  const s = await encrypted(keyring)
  fs.writeFileSync(path.join(s.wa, 'pre-key-9.json'), 'qlarenc1:dek:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  const decrypt = loadStateKeyring({ CONNECTOR_STATE_KEY: keyring.keys.get('v1')!.toString('base64'), CONNECTOR_STATE_MODE: 'decrypt' })
  const { log, lines } = memoryLog()
  const result = await prepareSessionState(s.dir, decrypt, log)
  assert.deepEqual(result, { ok: true, converted: 6, failed: 1 })
  assert.equal(fs.readFileSync(path.join(s.wa, 'pre-key-9.json'), 'utf-8'), 'qlarenc1:dek:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
  // state.key is kept while anything is still encrypted.
  assert.ok(fs.existsSync(path.join(s.dir, KEY_FILE)))
  assert.ok(lines.some((l) => l.level === 'error'))
})

test('writeMeta_Encrypt_SealsTokens_OtherFieldsPlain_ReadMetaRoundtrip', () => {
  const s = legacySession({ tokens: false })
  const keyring = loadStateKeyring({ CONNECTOR_STATE_KEY: testKey() })
  writeMeta(s.dir, { sessionId: s.sessionId, agentId: 'a', hubUrl: 'h', connectorToken: 'tok-1' }, keyring)
  const raw = JSON.parse(fs.readFileSync(path.join(s.dir, 'meta.json'), 'utf-8'))
  assert.equal(raw.agentId, 'a')
  assert.match(raw.connectorToken, /^qlarenc1:dek:/)
  assert.equal(raw.pendingConnectorToken, undefined)
  assert.equal(readMeta(s.dir, keyring).connectorToken, 'tok-1')
  assert.throws(() => readMeta(s.dir, plain), /no key/)
})
