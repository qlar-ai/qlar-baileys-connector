/**
 * Holds hub calls back until the connection has finished registering with Messenger-BE.
 *
 * The hub resolves a session by its registered connection, so a call made before Pair / Reconnect has
 * completed (or while SignalR is reconnecting) reaches a connection the server does not know yet and
 * is dropped or rejected. Closed at construction, opened once registration succeeds, closed again
 * when the transport drops.
 */
export class HubGate {
  private opened = false
  private waiters = new Set<() => void>()

  /** Whether the gate is open right now, for callers that must not defer a call by even a tick. */
  get isOpen(): boolean {
    return this.opened
  }

  open(): void {
    this.opened = true
    const released = [...this.waiters]
    this.waiters.clear()
    for (const release of released) release()
  }

  close(): void {
    this.opened = false
  }

  /** Resolves true as soon as the gate is open (immediately if it already is), false on timeout. */
  wait(timeoutMs: number): Promise<boolean> {
    if (this.opened) return Promise.resolve(true)

    return new Promise<boolean>((resolve) => {
      const release = () => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.waiters.delete(release)
        resolve(false)
      }, timeoutMs)
      this.waiters.add(release)
    })
  }
}
