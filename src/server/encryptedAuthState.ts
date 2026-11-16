import * as fsp from 'fs/promises'
import * as path from 'path'
import { getProcessKeyring, StateDecryptError, StateKeyring } from './stateCrypto'
import { atomicWriteFile, SessionStateCipher, StateLog, WA_DIR } from './sessionState'

/*
  Baileys' `useMultiFileAuthState`, with every file encoded through the session's state cipher:
  encrypted when the keyring encrypts, plaintext otherwise, and either format read back.

  Kept free of a Baileys import (Baileys is ESM-only and does not load under the tsx tests): the
  caller passes `initAuthCreds`, `BufferJSON` and `proto` in.

  Differences from Baileys', on purpose:
  - writes go to a temp file renamed into place, so a crash never leaves half a file;
  - a file that is encrypted but does not decrypt throws instead of reading as missing. Read as
    missing, creds.json would be replaced by fresh credentials on the next save and the customer's
    link would be gone; a key file would be replaced the same way.
*/

/** The slice of Baileys this needs; `typeof import('@whiskeysockets/baileys')` satisfies it. */
export interface AuthStateDeps {
  initAuthCreds: () => any
  BufferJSON: { replacer: (key: string, value: any) => any; reviver: (key: string, value: any) => any }
  proto: { Message: { AppStateSyncKeyData: { fromObject: (value: any) => any } } }
}

export interface AuthStateOptions {
  deps: AuthStateDeps
  keyring?: StateKeyring
  log?: StateLog
}

/** Same shape as Baileys' AuthenticationState with the keys store. */
export interface EncryptedAuthState {
  state: {
    creds: any
    keys: {
      get: (type: string, ids: string[]) => Promise<Record<string, any>>
      set: (data: Record<string, Record<string, any>>) => Promise<void>
    }
  }
  saveCreds: () => Promise<void>
}

// One lock per file path, process-wide: Baileys reads and writes the same key file concurrently.
const fileLocks = new Map<string, Promise<unknown>>()

function withFileLock<T>(filePath: string, work: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(filePath) ?? Promise.resolve()
  const run = previous.then(work, work)
  const settled = run.then(() => undefined, () => undefined)
  fileLocks.set(filePath, settled)
  void settled.then(() => {
    if (fileLocks.get(filePath) === settled) fileLocks.delete(filePath)
  })
  return run
}

const fixFileName = (file: string): string => file.replace(/\//g, '__').replace(/:/g, '-')

/**
 * Auth state for the session in `sessionDir` (files under `<sessionDir>/wa_session`). Run
 * `prepareSessionState` first for a stored session, so its files are already in the keyring's format.
 */
export async function useEncryptedMultiFileAuthState(sessionDir: string, options: AuthStateOptions): Promise<EncryptedAuthState> {
  const { initAuthCreds, BufferJSON, proto } = options.deps
  const keyring = options.keyring ?? getProcessKeyring()
  const log = options.log
  const folder = path.join(sessionDir, WA_DIR)

  const info = await fsp.stat(folder).catch(() => undefined)
  if (info && !info.isDirectory()) {
    throw new Error(`found something that is not a directory at ${folder}, either delete it or specify a different location`)
  }
  await fsp.mkdir(folder, { recursive: true })

  // Throws when the session's key file exists but does not unwrap: the session must not start.
  const cipher = SessionStateCipher.forSession(sessionDir, keyring)

  const writeData = (data: unknown, file: string): Promise<void> => {
    const name = fixFileName(file)
    const filePath = path.join(folder, name)
    return withFileLock(filePath, () => atomicWriteFile(filePath, cipher.encodeFile(name, JSON.stringify(data, BufferJSON.replacer))))
  }

  /** null when the file is missing or not JSON (as Baileys); throws when it is encrypted and does not open. */
  const readData = (file: string): Promise<any> => {
    const name = fixFileName(file)
    const filePath = path.join(folder, name)
    return withFileLock(filePath, async () => {
      let content: string
      try {
        content = await fsp.readFile(filePath, 'utf-8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
      let text: string
      try {
        text = cipher.decodeFile(name, content)
      } catch (err) {
        if (err instanceof StateDecryptError) log?.error({ file: name, err: err.message }, '[state] auth file does not decrypt - left untouched')
        throw err
      }
      try {
        return JSON.parse(text, BufferJSON.reviver)
      } catch {
        return null
      }
    })
  }

  const removeData = (file: string): Promise<void> => {
    const filePath = path.join(folder, fixFileName(file))
    return withFileLock(filePath, () => fsp.unlink(filePath).catch(() => undefined))
  }

  const creds = (await readData('creds.json')) || initAuthCreds()

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: Record<string, any> = {}
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`)
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value)
              }
              data[id] = value
            }),
          )
          return data
        },
        set: async (data) => {
          const tasks: Promise<void>[] = []
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id]
              const file = `${category}-${id}.json`
              tasks.push(value ? writeData(value, file) : removeData(file))
            }
          }
          await Promise.all(tasks)
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
  }
}
