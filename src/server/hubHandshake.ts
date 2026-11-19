import { randomBytes } from 'crypto'

/**
 * How a session re-registers with Messenger-BE's ConnectorHub after a restart or a transport blip.
 *
 * The connector proves it owns the session by presenting a per-session token through
 * `ReconnectSecure`. That method is new: a Messenger-BE that has not been redeployed does not have
 * it, and SignalR then answers "Method does not exist" - the connector falls back to the legacy
 * `Reconnect(sessionId)` so it keeps working exactly as before. A server that knows the session's
 * token and is shown a different one answers "Connector token rejected."; that is final, and is
 * returned rather than thrown so the caller can stop instead of retrying. A server that enforces tokens
 * (Messenger-BE `SecurityFase3:RequireConnectorToken`) answers a token-less registration with "This
 * session requires a secure reconnect. Update the connector."; that is final too.
 *
 * Kept free of SignalR and Baileys so the decision is unit-testable.
 */

/**
 * 'secured'         - the server accepted (or first-registered) the token: the session is protected.
 * 'legacy'          - an old server without ReconnectSecure; registered through Reconnect, token never seen.
 * 'rejected'        - the server holds a different token for this session.
 * 'secure-required' - the server refuses token-less connectors for this session (enforce mode, or a
 *                     secured session met by the legacy Reconnect).
 */
export type HandshakeResult = 'secured' | 'legacy' | 'rejected' | 'secure-required'

/** How a hub refusal is classified. Only 'transient' is worth another attempt with the same token. */
export type HubRefusal = 'rejected' | 'secure-required' | 'old-server' | 'transient'

/** Messenger-BE's refusal of a token-less connector: "This session requires a secure reconnect. Update the connector." */
export function isSecureReconnectRequired(err: unknown): boolean {
  return /requires a secure reconnect/i.test(errorMessage(err))
}

export function classifyHubError(err: unknown): HubRefusal {
  const msg = errorMessage(err)
  if (/token rejected/i.test(msg)) return 'rejected'
  if (isSecureReconnectRequired(err)) return 'secure-required'
  if (/method does not exist/i.test(msg)) return 'old-server'
  return 'transient'
}

/**
 * Whether the presented token must now be persisted: only a freshly generated one that the server
 * really registered. A legacy registration never saw it - persisting it would make the session look
 * secured here while the server cannot authenticate to it (an old server's DELETE carries no bearer).
 */
export function shouldPersistToken(result: HandshakeResult, wasFresh: boolean): boolean {
  return result === 'secured' && wasFresh
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A fresh connector token: 32 random bytes, base64url (43 characters, no padding). */
export function newConnectorToken(): string {
  return randomBytes(32).toString('base64url')
}

function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * The token to present at a handshake.
 *
 * - A promoted (server-registered) token always wins.
 * - Otherwise a pending one is reused: the server stores the first token it is shown (TOFU), so if
 *   it stored one but its reply never arrived, presenting a different token next time would be
 *   rejected and lock the session out. Reusing the same token until the hub answers avoids that.
 * - Only when there is neither is a new token generated; the caller must persist it as pending
 *   BEFORE presenting it, so it also survives a process restart.
 */
export function nextTokenToPresent(
  persisted: string | null | undefined,
  pending: string | null | undefined,
): { token: string; isNew: boolean; shouldPersistPending: boolean } {
  if (nonEmpty(persisted)) return { token: persisted, isNew: false, shouldPersistPending: false }
  if (nonEmpty(pending)) return { token: pending, isNew: false, shouldPersistPending: false }
  return { token: newConnectorToken(), isNew: true, shouldPersistPending: true }
}

/**
 * What to do with the presented token once the hub answered. Only 'secured' promotes a token that
 * was not already the persisted one; 'legacy' (old server, never saw it) and 'rejected' promote
 * nothing - a pending token is never used as the DELETE bearer or upload header.
 */
export function afterHandshake(result: HandshakeResult, presentedWasPersisted: boolean): { promote: boolean } {
  return { promote: shouldPersistToken(result, !presentedWasPersisted) }
}

export async function registerWithHub(
  conn: { invoke: (method: string, ...args: unknown[]) => Promise<unknown> },
  sessionId: string,
  token: string,
): Promise<HandshakeResult> {
  try {
    await conn.invoke('ReconnectSecure', sessionId, token)
    return 'secured'
  } catch (err) {
    const refusal = classifyHubError(err)
    if (refusal === 'rejected' || refusal === 'secure-required') return refusal
    if (refusal === 'old-server') {
      // A Messenger-BE that predates tokens. Any failure of the legacy call propagates as before,
      // except a refusal of token-less connectors, which is final like a rejected token.
      try {
        await conn.invoke('Reconnect', sessionId)
      } catch (legacyErr) {
        if (isSecureReconnectRequired(legacyErr)) return 'secure-required'
        throw legacyErr
      }
      return 'legacy'
    }
    throw err
  }
}

export type PostPairResult =
  | { outcome: 'secured'; token: string }
  | { outcome: 'unsecured'; reason: 'old-server' }
  | { outcome: 'rejected' }
  | { outcome: 'secure-required' }
  | { outcome: 'failed'; error: unknown; token: string; attempts: number }

/**
 * Delays between attempts of the post-pair secure step: five attempts over about 15 seconds, short
 * enough for the person waiting on the pairing request.
 */
export const SECURE_AFTER_PAIR_DELAYS_MS = [1000, 2000, 4000, 8000]

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Secure a freshly paired session on the same connection that paired it, by presenting a token
 * through `ReconnectSecure`. The server stores the first token it sees for that connection without
 * looking the account up (it does not exist yet during the wizard), and only a connection that
 * completed this step may send events once the server enforces tokens - so the caller must not
 * open its gate before this succeeds.
 *
 * - Accepted: 'secured'.
 * - A server that predates tokens ("method does not exist"): 'unsecured' / 'old-server'; nothing was
 *   stored and the session continues unsecured exactly as before tokens.
 * - "Connector token rejected." or "requires a secure reconnect": final, never retried.
 * - Anything else (the store was "temporarily unavailable", a timeout) is retried with the SAME token
 *   on {@link SECURE_AFTER_PAIR_DELAYS_MS}: the server may have stored it already (a lost reply), and
 *   a different token would then be rejected. The Pair registration of the connection survives a
 *   refused attempt. When every attempt failed, or `isCancelled` says the connection is no longer
 *   usable, the result is 'failed' with the token, which the caller keeps as pending.
 *
 * Unlike {@link registerWithHub} there is no fallback to `Reconnect` - that would fail with
 * "account not found" mid-wizard.
 */
export async function secureAfterPair(
  conn: { invoke: (method: string, ...args: unknown[]) => Promise<unknown> },
  sessionId: string,
  opts: {
    token?: string
    delaysMs?: number[]
    isCancelled?: () => boolean
    sleep?: (ms: number) => Promise<void>
    onRetry?: (err: unknown, attempt: number) => void
  } = {},
): Promise<PostPairResult> {
  const token = opts.token || newConnectorToken()
  const delays = opts.delaysMs ?? SECURE_AFTER_PAIR_DELAYS_MS
  const sleep = opts.sleep ?? realSleep
  const isCancelled = opts.isCancelled ?? (() => false)

  let lastError: unknown
  let attempts = 0
  for (let n = 1; n <= delays.length + 1; n++) {
    if (n > 1 && isCancelled()) break
    attempts = n
    try {
      await conn.invoke('ReconnectSecure', sessionId, token)
      return { outcome: 'secured', token }
    } catch (err) {
      const refusal = classifyHubError(err)
      if (refusal === 'rejected') return { outcome: 'rejected' }
      if (refusal === 'secure-required') return { outcome: 'secure-required' }
      if (refusal === 'old-server') return { outcome: 'unsecured', reason: 'old-server' }
      lastError = err
    }
    if (n > delays.length || isCancelled()) break
    opts.onRetry?.(lastError, n)
    await sleep(delays[n - 1])
  }
  return { outcome: 'failed', error: lastError, token, attempts }
}
