import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import {
  DEK_KEY_ID,
  envelopeKeyId,
  getProcessKeyring,
  isEnvelope,
  newDataKey,
  open,
  seal,
  StateDecryptError,
  StateKeyring,
  unwrapDataKey,
  wrapDataKey,
} from './stateCrypto'

/*
  One session's state at rest: `<dataRoot>/<sessionId>/` holding `meta.json`, `wa_session/*.json`
  (Baileys auth files) and, once encryption has been used, `state.key` (the session data key wrapped
  by the KEK). Everything here reads both formats; what it writes depends on the keyring mode.

  Fail safe for customer sessions: nothing here deletes or overwrites a file it could not read back.
*/

export const WA_DIR = 'wa_session'
export const META_FILE = 'meta.json'
export const KEY_FILE = 'state.key'
export const TOKEN_FIELDS = ['connectorToken', 'pendingConnectorToken'] as const
const TMP_SUFFIX = '.qlartmp'

export interface StateLog {
  info(obj: object, msg: string): void
  warn(obj: object, msg: string): void
  error(obj: object, msg: string): void
}

const silentLog: StateLog = { info() {}, warn() {}, error() {} }

let tmpCounter = 0
function tmpPathFor(filePath: string): string {
  tmpCounter = (tmpCounter + 1) % 1_000_000
  return `${filePath}.${process.pid}.${tmpCounter}${TMP_SUFFIX}`
}

/** Writes `content` beside `filePath`, flushes it, and renames it over `filePath`. */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const tmp = tmpPathFor(filePath)
  try {
    const fd = fs.openSync(tmp, 'w', 0o600)
    try {
      fs.writeFileSync(fd, content, 'utf-8')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, filePath)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* best effort */ }
    throw err
  }
}

/** Async {@link atomicWriteFileSync}. */
export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmp = tmpPathFor(filePath)
  try {
    const handle = await fsp.open(tmp, 'w', 0o600)
    try {
      await handle.writeFile(content, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fsp.rename(tmp, filePath)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => { /* best effort */ })
    throw err
  }
}

/**
 * Write `content` to a temp file, read it back, check it decodes to `expected`, and only then
 * rename it over `filePath`. Used for conversions: the original is never replaced by something
 * unreadable.
 */
async function verifiedReplace(filePath: string, content: string, decode: (written: string) => string, expected: string): Promise<void> {
  const tmp = tmpPathFor(filePath)
  try {
    const handle = await fsp.open(tmp, 'w', 0o600)
    try {
      await handle.writeFile(content, 'utf-8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    const back = await fsp.readFile(tmp, 'utf-8')
    if (decode(back) !== expected) throw new Error('converted copy did not read back identically')
    await fsp.rename(tmp, filePath)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => { /* best effort */ })
    throw err
  }
}

function aadFor(sessionId: string, place: string): string {
  return `${sessionId}/${place}`
}

function fieldPlace(field: string): string {
  return `${META_FILE}#${field}`
}

/**
 * Encodes and decodes one session's values. `dek` is undefined when the session has no data key
 * (plaintext session, or a keyring that cannot encrypt): then only plaintext can be read or written.
 */
export class SessionStateCipher {
  private constructor(
    readonly sessionId: string,
    private readonly dek: Buffer | undefined,
    /** Whether new values are written encrypted. */
    readonly writesEncrypted: boolean,
  ) {}

  /**
   * The cipher for writing and reading `sessionDir` under `keyring`.
   * - `encrypt` mode: unwraps `state.key`, creating it first when absent. Throws when it exists but
   *   does not unwrap (never replaces it here; see {@link prepareSessionState}).
   * - `decrypt` / `plaintext` mode: unwraps `state.key` when present and a key is available, writes plaintext.
   */
  static forSession(sessionDir: string, keyring: StateKeyring = getProcessKeyring()): SessionStateCipher {
    const sessionId = path.basename(sessionDir)
    const keyPath = path.join(sessionDir, KEY_FILE)
    const keyAad = aadFor(sessionId, KEY_FILE)

    if (keyring.mode === 'encrypt') {
      if (!fs.existsSync(keyPath)) createKeyFile(sessionDir, keyring)
      const { dek } = unwrapDataKey(keyring, fs.readFileSync(keyPath, 'utf-8'), keyAad)
      return new SessionStateCipher(sessionId, dek, true)
    }

    if (keyring.keys.size > 0 && fs.existsSync(keyPath)) {
      const { dek } = unwrapDataKey(keyring, fs.readFileSync(keyPath, 'utf-8'), keyAad)
      return new SessionStateCipher(sessionId, dek, false)
    }
    return new SessionStateCipher(sessionId, undefined, false)
  }

  /** Content to store for `fileName` (in wa_session) holding `text`. */
  encodeFile(fileName: string, text: string): string {
    return this.encode(fileName, text)
  }

  /** The text stored in `fileName`, whichever format it is in. Throws {@link StateDecryptError}. */
  decodeFile(fileName: string, content: string): string {
    return this.decode(fileName, content)
  }

  encodeField(field: string, value: string): string {
    return this.encode(fieldPlace(field), value)
  }

  decodeField(field: string, value: string): string {
    return this.decode(fieldPlace(field), value)
  }

  sealAlways(place: string, text: string): string {
    if (!this.dek) throw new StateDecryptError('no session key available to encrypt with')
    return seal(this.dek, DEK_KEY_ID, Buffer.from(text, 'utf-8'), aadFor(this.sessionId, place))
  }

  private encode(place: string, text: string): string {
    return this.writesEncrypted ? this.sealAlways(place, text) : text
  }

  private decode(place: string, content: string): string {
    if (!isEnvelope(content)) return content
    if (envelopeKeyId(content) !== DEK_KEY_ID) throw new StateDecryptError(`unexpected key id in ${place}`)
    if (!this.dek) {
      throw new StateDecryptError(`${place} is encrypted but no key for this session is available (CONNECTOR_STATE_KEY not set or ${KEY_FILE} missing)`)
    }
    return open(this.dek, content, aadFor(this.sessionId, place)).toString('utf-8')
  }
}

/**
 * Creates `state.key` with a fresh data key, exclusively: an existing file is never overwritten.
 * Returns without error when another writer created it first.
 */
function createKeyFile(sessionDir: string, keyring: StateKeyring): void {
  const sessionId = path.basename(sessionDir)
  const keyPath = path.join(sessionDir, KEY_FILE)
  const wrapped = wrapDataKey(keyring, newDataKey(), aadFor(sessionId, KEY_FILE))
  fs.mkdirSync(sessionDir, { recursive: true })
  let fd: number
  try {
    fd = fs.openSync(keyPath, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return
    throw err
  }
  try {
    fs.writeFileSync(fd, wrapped, 'utf-8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** Fields of meta.json; the token fields are plaintext here, whatever the file holds. */
export interface StoredMeta {
  sessionId: string
  agentId: string
  hubUrl: string
  connectorToken?: string
  pendingConnectorToken?: string
  [other: string]: unknown
}

/** Reads meta.json with its token fields decrypted. Throws on a token that does not decrypt. */
export function readMeta(sessionDir: string, keyring: StateKeyring = getProcessKeyring()): StoredMeta {
  const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, META_FILE), 'utf-8')) as StoredMeta
  const encrypted = TOKEN_FIELDS.filter((f) => typeof meta[f] === 'string' && isEnvelope(meta[f] as string))
  if (encrypted.length === 0) return meta
  const cipher = SessionStateCipher.forSession(sessionDir, keyring)
  const out: StoredMeta = { ...meta }
  for (const field of encrypted) out[field] = cipher.decodeField(field, meta[field] as string)
  return out
}

/** Writes meta.json, sealing the token fields when the keyring encrypts. */
export function writeMeta(sessionDir: string, meta: StoredMeta, keyring: StateKeyring = getProcessKeyring()): void {
  const out: StoredMeta = { ...meta }
  const tokens = TOKEN_FIELDS.filter((f) => typeof meta[f] === 'string' && meta[f] !== '')
  if (tokens.length > 0 && keyring.mode === 'encrypt') {
    const cipher = SessionStateCipher.forSession(sessionDir, keyring)
    for (const field of tokens) out[field] = cipher.encodeField(field, meta[field] as string)
  }
  fs.mkdirSync(sessionDir, { recursive: true })
  atomicWriteFileSync(path.join(sessionDir, META_FILE), JSON.stringify(out, null, 2))
}

/**
 * Whether a session directory holds credentials WhatsApp actually linked, in either format.
 *
 * The `wa_session` folder alone proves nothing: `WaSession.start` creates it before the first QR
 * is shown, so a pairing nobody ever scanned leaves an empty one behind. What only a completed link
 * writes is `creds.json` carrying `me` — the account WhatsApp accepted this device under.
 *
 * An unreadable `creds.json` counts as linked, and so does one that is encrypted with a key this
 * process does not have. Everything that reads this answer goes on to discard the session, and
 * throwing away a real number over a half-written file or a missing key would cost the customer a
 * re-pair; keeping a dead one costs a retry.
 */
export function isLinked(sessionDir: string, keyring?: StateKeyring): boolean {
  const credsPath = path.join(sessionDir, WA_DIR, 'creds.json')

  if (!fs.existsSync(credsPath)) return false

  try {
    let text = fs.readFileSync(credsPath, 'utf-8')
    if (isEnvelope(text)) text = SessionStateCipher.forSession(sessionDir, keyring ?? getProcessKeyring()).decodeFile('creds.json', text)
    const creds = JSON.parse(text) as { me?: { id?: string } }
    return Boolean(creds.me?.id)
  } catch {
    return true
  }
}

export type PrepareResult =
  | { ok: true; converted: number; failed: number }
  | { ok: false; reason: string }

interface Inventory {
  files: { name: string; content: string }[]
  meta?: Record<string, unknown>
  encryptedFiles: number
  encryptedFields: number
}

async function inventory(sessionDir: string, log: StateLog): Promise<Inventory> {
  const waDir = path.join(sessionDir, WA_DIR)
  const files: { name: string; content: string }[] = []
  let entries: fs.Dirent[] = []
  try {
    entries = await fsp.readdir(waDir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const filePath = path.join(waDir, entry.name)
    if (entry.name.endsWith(TMP_SUFFIX)) {
      // Left by a write that never reached its rename: the original is intact, the temp is not needed.
      await fsp.rm(filePath, { force: true }).catch(() => { /* best effort */ })
      continue
    }
    files.push({ name: entry.name, content: await fsp.readFile(filePath, 'utf-8') })
  }

  let meta: Record<string, unknown> | undefined
  try {
    meta = JSON.parse(await fsp.readFile(path.join(sessionDir, META_FILE), 'utf-8')) as Record<string, unknown>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn({ err: (err as Error).message }, '[state] meta.json unreadable, token fields left as they are')
  }

  return {
    files,
    meta,
    encryptedFiles: files.filter((f) => isEnvelope(f.content)).length,
    encryptedFields: meta ? TOKEN_FIELDS.filter((f) => typeof meta![f] === 'string' && isEnvelope(meta![f] as string)).length : 0,
  }
}

/**
 * Brings a stored session in line with the keyring before it is started, one file at a time:
 * - `encrypt`: makes sure the session has a data key (rewrapping it with the current KEK version
 *   when an older one wrapped it), then encrypts every plaintext auth file and token field.
 * - `decrypt`: decrypts every encrypted auth file and token field, then removes `state.key`.
 * - `plaintext`: changes nothing; refuses a session that holds encrypted values.
 *
 * Each converted file is written to a temp file, read back and checked before it replaces the
 * original. A value that does not decrypt is logged and left as it is. `ok: false` means the
 * session must not be started (and must not be wiped): its key is missing or wrong.
 * Must run before the session's WhatsApp socket starts (nothing else may write its files meanwhile).
 */
export async function prepareSessionState(sessionDir: string, keyring: StateKeyring = getProcessKeyring(), log: StateLog = silentLog): Promise<PrepareResult> {
  const sessionId = path.basename(sessionDir)
  const keyPath = path.join(sessionDir, KEY_FILE)
  const inv = await inventory(sessionDir, log)
  const hasEncrypted = inv.encryptedFiles + inv.encryptedFields > 0
  const refuse = (reason: string): PrepareResult => {
    log.error({ sessionId, reason }, '[state] session state cannot be read with the configured key - not started, files left untouched')
    return { ok: false, reason }
  }

  if (keyring.mode === 'plaintext') {
    if (hasEncrypted) return refuse('session is encrypted but CONNECTOR_STATE_KEY is not set')
    return { ok: true, converted: 0, failed: 0 }
  }

  // The data key.
  let cipher: SessionStateCipher
  const keyExists = fs.existsSync(keyPath)
  if (!keyExists && hasEncrypted) return refuse(`${KEY_FILE} is missing but the session holds encrypted values`)
  if (!keyExists && keyring.mode === 'decrypt') return { ok: true, converted: 0, failed: 0 }

  if (keyExists) {
    let unwrapped: { version: string } | undefined
    try {
      unwrapped = unwrapDataKey(keyring, await fsp.readFile(keyPath, 'utf-8'), aadFor(sessionId, KEY_FILE))
    } catch (err) {
      if (hasEncrypted) return refuse((err as Error).message)
      if (keyring.mode === 'decrypt') return { ok: true, converted: 0, failed: 0 }
      // Nothing is encrypted under this key (a write interrupted before first use, or a key from an
      // earlier encrypt/decrypt cycle): replacing it loses nothing.
      log.warn({ sessionId }, `[state] ${KEY_FILE} does not unwrap and nothing is encrypted with it - replacing it`)
      await fsp.rm(keyPath, { force: true })
    }
    if (unwrapped && keyring.mode === 'encrypt' && unwrapped.version !== keyring.currentVersion) {
      const { dek } = unwrapDataKey(keyring, await fsp.readFile(keyPath, 'utf-8'), aadFor(sessionId, KEY_FILE))
      const rewrapped = wrapDataKey(keyring, dek, aadFor(sessionId, KEY_FILE))
      await verifiedReplace(
        keyPath,
        rewrapped,
        (back) => unwrapDataKey(keyring, back, aadFor(sessionId, KEY_FILE)).dek.toString('base64'),
        dek.toString('base64'),
      )
      log.info({ sessionId, from: unwrapped.version, to: keyring.currentVersion }, `[state] ${KEY_FILE} rewrapped with the current key version`)
    }
  }
  try {
    cipher = SessionStateCipher.forSession(sessionDir, keyring)
  } catch (err) {
    return refuse((err as Error).message)
  }

  // creds.json decides: when it does not open, the key is wrong for this session.
  const creds = inv.files.find((f) => f.name === 'creds.json')
  if (creds && isEnvelope(creds.content)) {
    try {
      cipher.decodeFile(creds.name, creds.content)
    } catch (err) {
      return refuse((err as Error).message)
    }
  }
  // Token fields that do not open would leave the session presenting the wrong token.
  for (const field of TOKEN_FIELDS) {
    const value = inv.meta?.[field]
    if (typeof value === 'string' && isEnvelope(value)) {
      try {
        cipher.decodeField(field, value)
      } catch (err) {
        return refuse((err as Error).message)
      }
    }
  }

  const encrypt = keyring.mode === 'encrypt'
  let converted = 0
  let failed = 0

  for (const file of inv.files) {
    if (isEnvelope(file.content) === encrypt) continue
    const filePath = path.join(sessionDir, WA_DIR, file.name)
    try {
      if (encrypt) {
        await verifiedReplace(filePath, cipher.sealAlways(file.name, file.content), (back) => cipher.decodeFile(file.name, back), file.content)
      } else {
        const text = cipher.decodeFile(file.name, file.content)
        await verifiedReplace(filePath, text, (back) => back, text)
      }
      converted++
    } catch (err) {
      failed++
      log.error({ sessionId, file: file.name, err: (err as Error).message }, '[state] could not convert file - left as it is')
    }
  }

  if (inv.meta) {
    const meta = inv.meta
    const out: Record<string, unknown> = { ...meta }
    let changed = 0
    for (const field of TOKEN_FIELDS) {
      const value = meta[field]
      if (typeof value !== 'string' || value === '' || isEnvelope(value) === encrypt) continue
      out[field] = encrypt ? cipher.sealAlways(fieldPlace(field), value) : cipher.decodeField(field, value)
      changed++
    }
    if (changed > 0) {
      const expected = JSON.stringify(readableMeta(meta, cipher))
      try {
        await verifiedReplace(path.join(sessionDir, META_FILE), JSON.stringify(out, null, 2), (back) => JSON.stringify(readableMeta(JSON.parse(back), cipher)), expected)
        converted += changed
      } catch (err) {
        failed++
        log.error({ sessionId, file: META_FILE, err: (err as Error).message }, '[state] could not convert token fields - left as they are')
      }
    }
  }

  if (!encrypt && failed === 0) {
    const after = await inventory(sessionDir, log)
    if (after.encryptedFiles + after.encryptedFields === 0) await fsp.rm(keyPath, { force: true })
  }

  if (converted > 0 || failed > 0) {
    log.info({ sessionId, mode: keyring.mode, converted, failed }, '[state] session state converted')
  }
  return { ok: true, converted, failed }
}

function readableMeta(meta: Record<string, unknown>, cipher: SessionStateCipher): Record<string, unknown> {
  const out: Record<string, unknown> = { ...meta }
  for (const field of TOKEN_FIELDS) {
    if (typeof meta[field] === 'string') out[field] = cipher.decodeField(field, meta[field] as string)
  }
  return out
}
