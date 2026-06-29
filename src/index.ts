import { connectToHub } from './hub'
import { loadSession } from './session'

function parseArgs(): { hubUrl?: string; code?: string } {
  const args = process.argv.slice(2)
  const result: { hubUrl?: string; code?: string } = {}

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hub' && args[i + 1]) result.hubUrl = args[++i]
    if (args[i] === '--code' && args[i + 1]) result.code = args[++i]
  }

  return result
}

const { hubUrl: argHub, code } = parseArgs()

// Hub URL: CLI arg → env var → saved session
const session = loadSession()
const hubUrl = argHub ?? process.env.MESSENGER_BE_HUB_URL ?? session?.hubUrl

if (!hubUrl) {
  console.error(
    'Error: Hub URL is required.\n' +
    'Run with: ./connector --hub <MESSENGER_BE_HUB_URL> --code <PAIRING_CODE>\n' +
    'Or on subsequent runs: ./connector --hub <MESSENGER_BE_HUB_URL>',
  )
  process.exit(1)
}

if (!code && !session) {
  console.error(
    'Error: No session found and no pairing code provided.\n' +
    'Run with: ./connector --hub <MESSENGER_BE_HUB_URL> --code <PAIRING_CODE>',
  )
  process.exit(1)
}

console.log(`Pusaka Connector starting — Hub: ${hubUrl}`)
connectToHub(hubUrl, code)
