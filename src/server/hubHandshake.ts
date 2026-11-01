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
  | { outcome: 'unsecured'; reason: 'error'; error: unknown; token: string }
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
 * On any other failure the server may still have stored the token (a lost reply), so the token is
 * handed back for the caller to keep as pending and present again at the next handshake. On an old
 * server nothing was stored and no token is returned.
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
    return { outcome: 'unsecured', reason: 'error', error: err, token }
  }
}
