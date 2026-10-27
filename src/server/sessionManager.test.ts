import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Module from 'module'

// Loading the real ConnectorSession pulls in Baileys, whose ESM-only deps don't resolve under tsx.
// These tests never start a session, so stub the two modules that drag it in.
const origLoad = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === './connectorSession') return { ConnectorSession: class {} }
  if (request === './waSession') return { isLinked: () => true }
  return origLoad.call(this, request, ...rest)
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SessionManager } = require('./sessionManager') as typeof import('./sessionManager')

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-'))
  const dataRoot = path.join(base, 'data')
  fs.mkdirSync(dataRoot)
  fs.writeFileSync(path.join(base, 'keep.txt'), 'x')
  const tenant = path.join(dataRoot, 'real-id')
  fs.mkdirSync(tenant)
  fs.writeFileSync(path.join(tenant, 'meta.json'), '{}')
  return { base, dataRoot, tenant, manager: new SessionManager('http://localhost/hub', dataRoot) }
}

for (const [name, id] of [['DotDot', '..'], ['Empty', ''], ['TraversalToFile', '../keep.txt']] as const) {
  test(`stop_${name}_LeavesDataRootAndSiblingsIntact`, async () => {
    const s = setup()
    await s.manager.stop(id)
    assert.ok(fs.existsSync(path.join(s.base, 'keep.txt')))
    assert.ok(fs.existsSync(s.tenant))
    assert.ok(fs.existsSync(s.dataRoot))
  })
}
test('stop_RealId_RemovesTenantDir', async () => {
  const s = setup()
  await s.manager.stop('real-id')
  assert.ok(!fs.existsSync(s.tenant))
  assert.ok(fs.existsSync(path.join(s.base, 'keep.txt')))
})
