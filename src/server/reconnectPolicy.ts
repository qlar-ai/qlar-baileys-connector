export interface ReconnectDecision {
  reconnect: boolean
  delayMs: number
  reason: string
}

const BASE_DELAY_MS = 5_000
const MAX_DELAY_MS = 300_000
const JITTER = 0.2

/** 440 connectionReplaced, 403 forbidden, 411 multideviceMismatch: retrying only fights the other side. */
const TERMINAL_CODES = new Set([440, 403, 411])

/**
 * What to do after a socket close. 401 (logged out) is handled by the caller before this is asked.
 * Attempt 0 is a flat 5 s, as it always was (the post-pairing 515 restart depends on it); later
 * attempts back off exponentially to a 5 minute ceiling with +/-20% jitter.
 */
export function decideReconnect(
  statusCode: number | undefined,
  attempt: number,
  random: () => number = Math.random,
): ReconnectDecision {
  if (statusCode !== undefined && TERMINAL_CODES.has(statusCode)) {
    return { reconnect: false, delayMs: 0, reason: `terminal close code ${statusCode}` }
  }
  if (attempt <= 0) return { reconnect: true, delayMs: BASE_DELAY_MS, reason: 'first retry' }

  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
  const factor = 1 + (random() * 2 - 1) * JITTER
  return { reconnect: true, delayMs: Math.max(0, Math.round(base * factor)), reason: `backoff attempt ${attempt}` }
}
