import { loadSession } from './session'
import { startServer } from './server'

// End users never type a hub URL — this is baked into the shipped build at
// package time (see scripts/build.js's esbuild `define`, wired from the
// bundle:dev / bundle:prod npm scripts). --hub / MESSENGER_BE_HUB_URL stay as
// internal overrides for local/dev testing only. The literal below is only
// the fallback for unbundled runs (`npm run dev`), where no define applies.
const DEFAULT_HUB_URL = process.env.CONNECTOR_HUB_URL ?? 'https://wap-pusaka-messenger-dev.azurewebsites.net/hubs/connector'

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

// Local dev hubs (e.g. a developer's own `dotnet run` Messenger-BE) serve
// HTTPS with ASP.NET Core's self-signed dev cert, which Node rejects by
// default — every connection attempt would fail negotiation with no visible
// reason in the GUI. Only loopback targets get the bypass; the real hub
// always has a valid cert, so production connections stay strict.
if (/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/i.test(hubUrl)) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

startServer(hubUrl)
