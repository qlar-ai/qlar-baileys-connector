import { loadSession } from './session'
import { startServer } from './server'

// End users never type a hub URL — this is the production endpoint baked
// into the shipped build. --hub / MESSENGER_BE_HUB_URL stay as internal
// overrides for local/dev testing only.
const DEFAULT_HUB_URL = 'https://wap-pusaka-messenger-dev.azurewebsites.net/hubs/connector'

function parseArgs(): { hubUrl?: string } {
  const args = process.argv.slice(2)
  const result: { hubUrl?: string } = {}

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hub' && args[i + 1]) result.hubUrl = args[++i]
  }

  return result
}

const { hubUrl: argHub } = parseArgs()
const session = loadSession()

// Hub URL: CLI arg → env var → saved session (so a machine paired against DEV
// keeps reconnecting to DEV) → default.
const hubUrl = argHub ?? process.env.MESSENGER_BE_HUB_URL ?? session?.hubUrl ?? DEFAULT_HUB_URL

startServer(hubUrl)
