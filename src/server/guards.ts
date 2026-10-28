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

/**
 * Read a request body, rejecting if it exceeds maxBytes, stalls past timeoutMs, or the client aborts.
 * On over-limit / timeout the request is paused (nothing more is buffered) but NOT destroyed, so the
 * caller can still write its 413 / 408 response; the caller closes the connection afterwards.
 */
export function readBodyLimited(req: http.IncomingMessage, maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false

    const onData = (chunk: Buffer | string): void => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > maxBytes) {
        finish(() => reject(new PayloadTooLargeError('request body too large')), true)
        return
      }
      chunks.push(buf)
    }
    const onEnd = (): void => finish(() => resolve(Buffer.concat(chunks).toString('utf-8')), false)
    const onAborted = (): void => finish(() => reject(new Error('request aborted')), false)
    const onError = (err: Error): void => finish(() => reject(err), false)
    const onClose = (): void => finish(() => reject(new Error('request closed before end')), false)
    const timer = setTimeout(
      () => finish(() => reject(new RequestTimeoutError('request body timed out')), true),
      timeoutMs,
    )

    const finish = (settle: () => void, stopReading: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.removeListener('data', onData)
      req.removeListener('end', onEnd)
      req.removeListener('aborted', onAborted)
      req.removeListener('error', onError)
      req.removeListener('close', onClose)
      // A late socket error must not become an uncaught exception once we stop listening.
      req.on('error', () => { /* ignore */ })
      if (stopReading) req.pause()
      settle()
    }

    req.on('data', onData)
    req.on('end', onEnd)
    req.on('aborted', onAborted)
    req.on('error', onError)
    req.on('close', onClose)
  })
}
