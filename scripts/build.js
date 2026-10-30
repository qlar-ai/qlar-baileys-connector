const esbuild = require('esbuild')
const fs = require('fs')

// One bundle serves every environment: the hub URL is given on the command line when the
// connector runs, never baked in here.
const { version } = require('../package.json')

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
    entryPoints: ['src/selfhosted/main.ts'],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile: 'dist-bundle/qlar-connector.cjs',
    define: { __CONNECTOR_VERSION__: JSON.stringify(version) },
    plugins: [patchSignalRDynamicRequire],
  })
  .catch(() => process.exit(1))
