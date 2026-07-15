const esbuild = require('esbuild')
const fs = require('fs')

const hubUrl = process.argv[2]
if (!hubUrl) {
  console.error('Usage: node scripts/build.js <hub-url>')
  process.exit(1)
}

// @microsoft/signalr resolves its Node-only deps (ws, eventsource,
// tough-cookie, node-fetch, fetch-cookie, abort-controller) via a
// variable-aliased require (its webpack escape hatch:
// `__non_webpack_require__`) so bundlers can't see they're real
// dependencies. esbuild leaves each as a runtime require(), which pkg's
// static analyzer then can't detect either — the packaged exe ends up
// missing the module entirely (MODULE_NOT_FOUND at runtime, inside
// HttpConnection.js and FetchHttpClient.js). Rewriting `requireFunc(x)` to
// a literal `require(x)` here lets esbuild inline each module for real, so
// nothing is left to resolve at runtime.
const patchSignalRDynamicRequire = {
  name: 'patch-signalr-dynamic-require',
  setup(build) {
    build.onLoad({ filter: /@microsoft[\\/]signalr[\\/]dist[\\/]cjs[\\/].*\.js$/ }, (args) => {
      const contents = fs.readFileSync(args.path, 'utf8')
      if (!contents.includes('requireFunc(')) return null
      return {
        contents: contents.replace(/requireFunc\((["'][^"']+["'])\)/g, 'require($1)'),
        loader: 'js',
      }
    })
  },
}

esbuild
  .build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    outfile: 'dist-bundle/index.cjs',
    define: { 'process.env.CONNECTOR_HUB_URL': JSON.stringify(hubUrl) },
    plugins: [patchSignalRDynamicRequire],
  })
  .catch(() => process.exit(1))
