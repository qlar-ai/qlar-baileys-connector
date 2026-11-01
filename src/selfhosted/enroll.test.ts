import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { hasEnrolledSession, runEnroll, runRestore, type ManagerLike } from './enroll'
import { UsageError } from './options'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'enroll-'))

function fakeManager() {
  const calls: string[] = []
  const manager: ManagerLike = {
    async startFromCode(code) { calls.push(`start:${code}`) },
    async restore() { calls.push('restore') },
    count: () => 0,
  }
  return { manager, calls }
}

const linked = () => true
const unlinked = () => false

test('hasEnrolledSession_EmptyDir_False', () => assert.equal(hasEnrolledSession(tmp(), linked), false))
test('hasEnrolledSession_MissingDir_False', () => assert.equal(hasEnrolledSession(path.join(tmp(), 'nope'), linked), false))
test('hasEnrolledSession_LinkedSubdirWithMeta_True', () => {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'abc'))
  fs.writeFileSync(path.join(root, 'abc', 'meta.json'), '{}')
  assert.equal(hasEnrolledSession(root, linked), true)
})
test('hasEnrolledSession_SubdirWithoutMeta_False', () => {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'abc'))
  assert.equal(hasEnrolledSession(root, linked), false)
})
// Pair writes meta.json before anyone has scanned. A restart then wipes that half-made session,
// so it must not count as enrolled: the spent code would be ignored and the container left idle.
test('hasEnrolledSession_SessionNeverLinkedToWhatsApp_False', () => {
  const root = tmp()
  fs.mkdirSync(path.join(root, 'abc'))
  fs.writeFileSync(path.join(root, 'abc', 'meta.json'), '{}')
  assert.equal(hasEnrolledSession(root, unlinked), false)
})

test('runEnroll_EnrolledWithSpentCode_RestoresAndDoesNotStartFromCode', async () => {
  const { manager, calls } = fakeManager()
  const logs: string[] = []
  await runEnroll(manager, { code: 'SPENT', enrolled: true }, (m) => logs.push(m))
  assert.deepEqual(calls, ['restore'])
  assert.match(logs.join('\n'), /already enrolled/)
})
test('runEnroll_FreshWithCode_StartsFromCode', async () => {
  const { manager, calls } = fakeManager()
  await runEnroll(manager, { code: 'AB12', enrolled: false }, () => {})
  assert.deepEqual(calls, ['start:AB12'])
})
test('runEnroll_FreshWithoutCode_ThrowsUsageError', async () => {
  const { manager, calls } = fakeManager()
  await assert.rejects(runEnroll(manager, { enrolled: false }, () => {}), (e: unknown) => e instanceof UsageError && /pairing code is required/.test((e as Error).message))
  assert.deepEqual(calls, [])
})
test('runRestore_Nothing_ThrowsUsageErrorNamingEnroll', async () => {
  const { manager } = fakeManager()
  await assert.rejects(runRestore(manager, false), (e: unknown) => e instanceof UsageError && /enroll/.test((e as Error).message))
})
test('runRestore_Enrolled_Restores', async () => {
  const { manager, calls } = fakeManager()
  await runRestore(manager, true)
  assert.deepEqual(calls, ['restore'])
})
