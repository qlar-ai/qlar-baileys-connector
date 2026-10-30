declare const __CONNECTOR_VERSION__: string | undefined

/** Replaced at bundle time by esbuild; the Docker image sets CONNECTOR_VERSION instead. */
export function connectorVersion(env: NodeJS.ProcessEnv): string {
  const bundled = typeof __CONNECTOR_VERSION__ === 'string' ? __CONNECTOR_VERSION__ : undefined
  return bundled || env.CONNECTOR_VERSION?.trim() || 'dev'
}

/** Fails early with a readable message instead of an obscure error from a dependency. */
export function assertNodeVersion(version: string, minMajor = 24): void {
  const clean = version.replace(/^v/, '')
  if (Number.parseInt(clean.split('.')[0], 10) < minMajor) {
    throw new Error(`Node ${minMajor} or newer is required, found v${clean}`)
  }
}

/** What the operator reads when `enroll` fails, with the next thing to try. */
export function describeFailure(err: unknown, hubUrl: string): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/invalid|expired/i.test(message)) {
    return 'The pairing code is invalid or has expired. Create a new code in the Qlar CMS and run the command again.'
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|negotiation|Failed to (start|complete)/i.test(message)) {
    return `Could not reach the Qlar hub at ${hubUrl}. Check this machine's outbound HTTPS access. (${message})`
  }
  return message
}
