import { randomBytes } from 'crypto'

/**
 * How a session re-registers with Messenger-BE's ConnectorHub after a restart or a transport blip.
 *
 * The connector proves it owns the session by presenting a per-session token through
 * `ReconnectSecure`. That method is new: a Messenger-BE that has not been redeployed does not have
 * it, and SignalR then answers "Method does not exist" - the connector falls back to the legacy
 * `Reconnect(sessionId)` so it keeps working exactly as before. A server that knows the session's
 * token and is shown a different one answers "Connector token rejected."; that is final, and is
 * returned rather than thrown so the caller can stop instead of retrying.
 *
 * Kept free of SignalR and Baileys so the decision is unit-testable.
 */

/**
 * 'secured'  - the server accepted (or first-registered) the token: the session is protected.
 * 'legacy'   - an old server without ReconnectSecure; registered through Reconnect, token never seen.
 * 'rejected' - the server holds a different token for this session.
 */
export type HandshakeResult = 'secured' | 'legacy' | 'rejected'

/**
 * Whether the presented token must now be persisted: only a freshly generated one that the server
 * really registered. A legacy registration never saw it - persisting it would make the session look
 * secured here while the server cannot authenticate to it (an old server's DELETE carries no bearer).
 */
export function shouldPersistToken(result: HandshakeResult, wasFresh: boolean): boolean {
  return result === 'secured' && wasFresh
}

/** A fresh connector token: 32 random bytes, base64url (43 characters, no padding). */
export function newConnectorToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * The token to present: the stored one when there is one, otherwise a freshly generated one that
 * the caller must persist once the hub has accepted it (the server registers the first token it is
 * shown for a session that has none).
 */
export function tokenToPresent(stored: string | null | undefined): { token: string; fresh: boolean } {
  if (typeof stored === 'string' && stored.length > 0) return { token: stored, fresh: false }
  return { token: newConnectorToken(), fresh: true }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
    const msg = errorMessage(err)
    if (/token rejected/i.test(msg)) return 'rejected'
    if (/method does not exist/i.test(msg)) {
      // A Messenger-BE that predates tokens. Any failure of the legacy call propagates as before.
      await conn.invoke('Reconnect', sessionId)
      return 'legacy'
    }
    throw err
  }
}

export type PostPairResult =
  | { outcome: 'secured'; token: string }
  | { outcome: 'unsecured'; reason: 'old-server' }
  | { outcome: 'unsecured'; reason: 'error'; error: unknown }
  | { outcome: 'rejected' }

/**
 * Secure a freshly paired session on the same connection that paired it: generate a token and
 * present it through `ReconnectSecure`. The server stores the first token it sees for that
 * connection without looking the account up (it does not exist yet during the wizard).
 *
 * Unlike {@link registerWithHub} there is no fallback to `Reconnect` - that would fail with
 * "account not found" mid-wizard. A server that predates tokens, or any other failure, leaves the
 * session unsecured and working as before; pairing must never fail because this step did.
 * Only an explicit "token rejected" is reported as such.
 *
 * Accepted edge case: if the server stored the token but its reply was lost, this reports
 * 'unsecured' and nothing is persisted, so a later restart presents a different token and is
 * rejected until the session is paired again. Rare, and preferred over guessing.
 */
export async function secureAfterPair(
  conn: { invoke: (method: string, ...args: unknown[]) => Promise<unknown> },
  sessionId: string,
): Promise<PostPairResult> {
  const token = newConnectorToken()
  try {
    await conn.invoke('ReconnectSecure', sessionId, token)
    return { outcome: 'secured', token }
  } catch (err) {
    const msg = errorMessage(err)
    if (/token rejected/i.test(msg)) return { outcome: 'rejected' }
    if (/method does not exist/i.test(msg)) return { outcome: 'unsecured', reason: 'old-server' }
    return { outcome: 'unsecured', reason: 'error', error: err }
  }
}
