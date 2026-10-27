const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run `attempt` until it succeeds, sleeping between failures. The delays are used in order and the
 * last one repeats forever, so a hub that stays down is polled at a steady, gentle rate.
 *
 * Returns undefined only when cancelled (checked before every attempt, including the first, and after
 * every sleep). A successful first attempt returns at once, with no sleep.
 */
export async function retryUntil<T>(
  attempt: () => Promise<T>,
  opts: {
    delaysMs: number[]
    isCancelled: () => boolean
    sleep?: (ms: number) => Promise<void>
    onError?: (err: unknown, n: number) => void
  },
): Promise<T | undefined> {
  const sleep = opts.sleep ?? realSleep
  const delays = opts.delaysMs.length > 0 ? opts.delaysMs : [1000]

  for (let n = 1; ; n++) {
    if (opts.isCancelled()) return undefined
    try {
      return await attempt()
    } catch (err) {
      opts.onError?.(err, n)
    }
    if (opts.isCancelled()) return undefined
    await sleep(delays[Math.min(n - 1, delays.length - 1)])
  }
}
