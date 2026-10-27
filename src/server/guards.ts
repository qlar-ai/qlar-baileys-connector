import * as http from 'http'
import * as path from 'path'

/**
 * Resolve a session id to its directory under `dataRoot`, or null if the id could escape it.
 * Checks containment and separators rather than a strict id shape, so any safe id still works.
 */
export function resolveSessionDir(dataRoot: string, sessionId: string): string | null {
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId === '.' || sessionId === '..') return null
  if (/[/\\\0]/.test(sessionId)) return null

  const root = path.resolve(dataRoot)
  const dir = path.resolve(root, sessionId)
  const rel = path.relative(root, dir)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  if (path.dirname(dir) !== root) return null
  return dir
}

export class PayloadTooLargeError extends Error {}
export class RequestTimeoutError extends Error {}

/** Read a request body, rejecting if it exceeds maxBytes, stalls past timeoutMs, or the client aborts. */
export function readBodyLimited(req: http.IncomingMessage, maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      finish(() => {
        reject(new RequestTimeoutError('request body timed out'))
        req.destroy()
      })
    }, timeoutMs)

    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > maxBytes) {
        finish(() => {
          reject(new PayloadTooLargeError('request body too large'))
          req.destroy()
        })
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => finish(() => resolve(Buffer.concat(chunks).toString('utf-8'))))
    req.on('aborted', () => finish(() => reject(new Error('request aborted'))))
    req.on('error', (err) => finish(() => reject(err)))
    req.on('close', () => finish(() => reject(new Error('request closed before end'))))
  })
}
