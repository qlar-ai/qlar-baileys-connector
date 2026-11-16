import * as crypto from 'crypto'

/*
  Encryption of the connector's state at rest: the WhatsApp (Baileys) auth files and the connector
  token in meta.json. No Baileys import here, so it can be tested under tsx.

  Envelope: `qlarenc1:<keyId>:` + base64(iv[12] | ciphertext | tag[16]), AES-256-GCM, with
  additional authenticated data naming where the value lives (`<sessionId>/<fileName>`), so a file
  or a field copied to another session, or renamed inside one, no longer decrypts.

  Keys: the key-encryption key (KEK) comes from the environment (`CONNECTOR_STATE_KEY`, hosted from
  Key Vault through an app setting reference). Each session has its own random data key (DEK),
  wrapped by the KEK in `<sessionDir>/state.key`. Data files and token fields are sealed with the DEK
  (keyId `dek`); the wrapped DEK names the KEK version that wrapped it, so a KEK rotation only
  rewraps one small file per session.
*/

export const ENVELOPE_PREFIX = 'qlarenc1:'
/** keyId of values sealed with a session's data key. */
export const DEK_KEY_ID = 'dek'

const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const VERSION_PATTERN = /^[a-z0-9]{1,16}$/
const RESERVED_VERSIONS = new Set([DEK_KEY_ID, 'version'])

export type StateMode = 'plaintext' | 'encrypt' | 'decrypt'

/**
 * What the process may do with state at rest. Never logged as is: use {@link describeKeyring}.
 * - `plaintext`: no key configured; reads and writes plaintext, refuses encrypted sessions.
 * - `encrypt`: writes encrypted and converts plaintext sessions at start.
 * - `decrypt`: emergency rollback; converts encrypted sessions back to plaintext at start.
 */
export interface StateKeyring {
  readonly mode: StateMode
  /** Version of the KEK new data keys are wrapped with; undefined when no key is configured. */
  readonly currentVersion?: string
  /** Every KEK this process can unwrap with, keyed by lower-case version. */
  readonly keys: ReadonlyMap<string, Buffer>
}

/** The configuration is unusable; the process must not start with it. Never carries a key value. */
export class StateKeyConfigError extends Error {}

/** A sealed value could not be opened: wrong or missing key, wrong place, or tampered. Never carries plaintext. */
export class StateDecryptError extends Error {}

function parseKey(name: string, raw: string): Buffer {
  const value = raw.trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new StateKeyConfigError(`${name} is not valid base64 (expected 32 random bytes, base64-encoded)`)
  }
  const key = Buffer.from(value, 'base64')
  if (key.length !== KEY_BYTES) {
    throw new StateKeyConfigError(`${name} must decode to ${KEY_BYTES} bytes, got ${key.length}`)
  }
  return key
}

function parseVersion(name: string, raw: string): string {
  const version = raw.trim().toLowerCase()
  if (!VERSION_PATTERN.test(version) || RESERVED_VERSIONS.has(version)) {
    throw new StateKeyConfigError(`${name} must be 1-16 letters or digits (and not "dek" or "version")`)
  }
  return version
}

/**
 * Reads the key configuration:
 * - `CONNECTOR_STATE_KEY`: the current KEK (base64, 32 bytes). Optional.
 * - `CONNECTOR_STATE_KEY_VERSION`: its version, default `v1`.
 * - `CONNECTOR_STATE_KEY_<version>`: older KEKs, only for unwrapping (rotation).
 * - `CONNECTOR_STATE_MODE`: empty (encrypt when a key is set, else plaintext), `encrypt` or `decrypt`.
 */
export function loadStateKeyring(env: NodeJS.ProcessEnv): StateKeyring {
  const keys = new Map<string, Buffer>()

  for (const [name, raw] of Object.entries(env)) {
    const match = /^CONNECTOR_STATE_KEY_([A-Za-z0-9]{1,16})$/.exec(name)
    if (!match || match[1].toUpperCase() === 'VERSION' || raw === undefined || raw.trim() === '') continue
    const version = parseVersion(name, match[1])
    if (keys.has(version)) throw new StateKeyConfigError(`more than one variable configures key version ${version}`)
    keys.set(version, parseKey(name, raw))
  }

  let currentVersion: string | undefined
  const current = env.CONNECTOR_STATE_KEY?.trim()
  if (current) {
    currentVersion = parseVersion('CONNECTOR_STATE_KEY_VERSION', env.CONNECTOR_STATE_KEY_VERSION?.trim() || 'v1')
    const key = parseKey('CONNECTOR_STATE_KEY', current)
    const sameVersion = keys.get(currentVersion)
    if (sameVersion && !sameVersion.equals(key)) {
      throw new StateKeyConfigError(`CONNECTOR_STATE_KEY and CONNECTOR_STATE_KEY_${currentVersion.toUpperCase()} disagree for version ${currentVersion}`)
    }
    keys.set(currentVersion, key)
  }

  const rawMode = (env.CONNECTOR_STATE_MODE ?? '').trim().toLowerCase()
  let mode: StateMode
  if (rawMode === '') {
    mode = currentVersion ? 'encrypt' : 'plaintext'
  } else if (rawMode === 'encrypt') {
    if (!currentVersion) throw new StateKeyConfigError('CONNECTOR_STATE_MODE=encrypt needs CONNECTOR_STATE_KEY')
    mode = 'encrypt'
  } else if (rawMode === 'decrypt') {
    if (keys.size === 0) throw new StateKeyConfigError('CONNECTOR_STATE_MODE=decrypt needs the key the state was encrypted with')
    mode = 'decrypt'
  } else {
    throw new StateKeyConfigError('CONNECTOR_STATE_MODE must be empty, "encrypt" or "decrypt"')
  }

  return { mode, currentVersion, keys }
}

/** Safe to log: mode and versions, never key material. */
export function describeKeyring(keyring: StateKeyring): { mode: StateMode; keyVersion?: string; readableVersions: string[] } {
  return { mode: keyring.mode, keyVersion: keyring.currentVersion, readableVersions: [...keyring.keys.keys()].sort() }
}

let processKeyring: StateKeyring | undefined

/** The keyring of this process, read once from `process.env`. Throws {@link StateKeyConfigError} on bad config. */
export function getProcessKeyring(): StateKeyring {
  if (!processKeyring) processKeyring = loadStateKeyring(process.env)
  return processKeyring
}

export function isEnvelope(content: string): boolean {
  return content.startsWith(ENVELOPE_PREFIX)
}

/** The keyId of an envelope, or undefined when `content` is not one. */
export function envelopeKeyId(content: string): string | undefined {
  if (!isEnvelope(content)) return undefined
  const end = content.indexOf(':', ENVELOPE_PREFIX.length)
  return end > ENVELOPE_PREFIX.length ? content.slice(ENVELOPE_PREFIX.length, end) : undefined
}

export function seal(key: Buffer, keyId: string, plaintext: Buffer, aad: string): string {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf-8'))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${ENVELOPE_PREFIX}${keyId}:${Buffer.concat([iv, body, tag]).toString('base64')}`
}

/** Opens an envelope sealed by {@link seal} under `aad`. Throws {@link StateDecryptError}. */
export function open(key: Buffer, envelope: string, aad: string): Buffer {
  const keyId = envelopeKeyId(envelope)
  if (keyId === undefined) throw new StateDecryptError(`not an encrypted value (${aad})`)
  const raw = Buffer.from(envelope.slice(ENVELOPE_PREFIX.length + keyId.length + 1).trim(), 'base64')
  if (raw.length < IV_BYTES + TAG_BYTES) throw new StateDecryptError(`encrypted value is truncated (${aad})`)
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES))
    decipher.setAAD(Buffer.from(aad, 'utf-8'))
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES))
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()])
  } catch {
    throw new StateDecryptError(`encrypted value does not open with this key at this place (${aad})`)
  }
}

export function newDataKey(): Buffer {
  return crypto.randomBytes(KEY_BYTES)
}

/** Wraps a session data key with the current KEK. */
export function wrapDataKey(keyring: StateKeyring, dek: Buffer, aad: string): string {
  if (!keyring.currentVersion) throw new StateKeyConfigError('no CONNECTOR_STATE_KEY configured')
  return seal(keyring.keys.get(keyring.currentVersion)!, keyring.currentVersion, dek, aad)
}

/** Unwraps a session data key with whichever configured KEK version wrapped it. */
export function unwrapDataKey(keyring: StateKeyring, wrapped: string, aad: string): { dek: Buffer; version: string } {
  const version = envelopeKeyId(wrapped.trim())?.toLowerCase()
  if (!version) throw new StateDecryptError(`session key file is not an encrypted value (${aad})`)
  const kek = keyring.keys.get(version)
  if (!kek) throw new StateDecryptError(`session key is wrapped with key version ${version}, which is not configured (${aad})`)
  const dek = open(kek, wrapped.trim(), aad)
  if (dek.length !== KEY_BYTES) throw new StateDecryptError(`session key has the wrong length (${aad})`)
  return { dek, version }
}

/** What to warn the operator about at start, or undefined when state is encrypted as it should be. */
export function stateStartupWarning(keyring: StateKeyring, stateDir: string): string | undefined {
  if (keyring.mode === 'plaintext') {
    return `CONNECTOR_STATE_KEY is not set: WhatsApp session state and connector tokens in ${stateDir} are stored UNENCRYPTED. Set CONNECTOR_STATE_KEY (32 random bytes, base64) to encrypt them.`
  }
  if (keyring.mode === 'decrypt') {
    return `CONNECTOR_STATE_MODE=decrypt: session state in ${stateDir} is converted back to plaintext and stored UNENCRYPTED.`
  }
  return undefined
}
