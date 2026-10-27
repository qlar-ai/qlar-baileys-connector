import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Module from 'module'

// Loading the real ConnectorSession pulls in Baileys, whose ESM-only deps don't resolve under tsx.
// These tests never start a session, so stub the two modules that drag it in.
// The stub records each session it is asked to create, so the token flow can be checked without Baileys.
type FakeHandlers = { onRegistered: (m: unknown) => void; onClosed: (id: string) => void; onToken: (id: string, t: string) => void }
type FakeOpts = { code?: string; sessionId?: string; agentId?: string; connectorToken?: string }
const created: FakeSession[] = []
class FakeSession {
  constructor(public hubUrl: string, public dataRoot: string, public opts: FakeOpts, public handlers: FakeHandlers) {
    created.push(this)
  }
  async start(): Promise<void> { /* no hub */ }
  async stop(): Promise<void> { /* nothing */ }
  async revoke(): Promise<void> { /* nothing */ }
  getConnectorToken(): string | undefined { return this.opts.connectorToken }
}
const origLoad = (Module as any)._load
;(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === './connectorSession') return { ConnectorSession: FakeSession }
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

function setupWithMeta(meta: Record<string, unknown>) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-tok-'))
  const dir = path.join(dataRoot, String(meta.sessionId))
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta))
  created.length = 0
  return { dataRoot, dir, manager: new SessionManager('http://localhost/hub', dataRoot) }
}

test('restore_MetaWithoutToken_StillRestores_NoTokenPassed', async () => {
  const s = setupWithMeta({ sessionId: 'old-1', agentId: 'agent-1', hubUrl: 'http://localhost/hub' })
  await s.manager.restore()
  assert.equal(created.length, 1)
  assert.equal(created[0].opts.sessionId, 'old-1')
  assert.equal(created[0].opts.connectorToken, undefined)
  assert.equal(s.manager.count(), 1)
  assert.equal(s.manager.tokenFor('old-1'), undefined)
  assert.equal(s.manager.isLive('old-1'), true)
  assert.equal(s.manager.isLive('unknown'), false)
})

test('restore_MetaWithToken_PassesTokenToSession_TokenForReturnsIt', async () => {
  const s = setupWithMeta({ sessionId: 'new-1', agentId: 'agent-1', hubUrl: 'http://localhost/hub', connectorToken: 'tok-A' })
  await s.manager.restore()
  assert.equal(created[0].opts.connectorToken, 'tok-A')
  assert.equal(s.manager.tokenFor('new-1'), 'tok-A')
  assert.equal(s.manager.tokenFor('unknown'), undefined)
})

test('onToken_MergesTokenIntoMetaJson_KeepsOtherFields', async () => {
  const s = setupWithMeta({ sessionId: 'old-2', agentId: 'agent-2', hubUrl: 'http://localhost/hub' })
  await s.manager.restore()
  created[0].handlers.onToken('old-2', 'fresh-token')
  const meta = JSON.parse(fs.readFileSync(path.join(s.dir, 'meta.json'), 'utf-8'))
  assert.deepEqual(meta, { sessionId: 'old-2', agentId: 'agent-2', hubUrl: 'http://localhost/hub', connectorToken: 'fresh-token' })
})

test('onToken_UnsafeSessionId_WritesNothingOutsideDataRoot', async () => {
  const s = setupWithMeta({ sessionId: 'old-3', agentId: 'a', hubUrl: 'h' })
  await s.manager.restore()
  created[0].handlers.onToken('..', 'evil')
  assert.ok(!fs.existsSync(path.join(path.dirname(s.dataRoot), 'meta.json')))
})

test('register_PairResultWithNullToken_WritesMetaWithoutCrashing', async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-pair-'))
  created.length = 0
  const manager = new SessionManager('http://localhost/hub', dataRoot)
  await manager.startFromCode('CODE1')
  created[0].handlers.onRegistered({ sessionId: 'paired-1', agentId: 'a', hubUrl: 'h', connectorToken: undefined })
  const meta = JSON.parse(fs.readFileSync(path.join(dataRoot, 'paired-1', 'meta.json'), 'utf-8'))
  assert.deepEqual(meta, { sessionId: 'paired-1', agentId: 'a', hubUrl: 'h' })
})
