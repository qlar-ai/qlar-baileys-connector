/**
 * The Messenger-BE hub the hosted server registers its sessions with. There is deliberately no
 * default: a missing value must stop the process, not quietly dial somebody's dev environment.
 */
export function requireHubUrl(env: NodeJS.ProcessEnv): string {
  const value = (env.HUB_URL ?? env.MESSENGER_BE_HUB_URL ?? '').trim()
  if (!value) throw new Error('HUB_URL is not set (the hub the connector registers with)')
  return value
}
