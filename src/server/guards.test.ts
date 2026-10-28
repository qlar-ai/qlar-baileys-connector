import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { EventEmitter } from 'events'
import type * as http from 'http'
import { resolveSessionDir, readBodyLimited, PayloadTooLargeError, RequestTimeoutError } from './guards'

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), 'guards-'))
const fakeReq = () => Object.assign(new EventEmitter(), { destroy() { throw new Error('readBodyLimited must not destroy the request') }, pause() {} }) as unknown as http.IncomingMessage & EventEmitter

test('resolveSessionDir_Guid_ReturnsChildPath', () => {
  const r = root()
  const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
  assert.equal(resolveSessionDir(r, id), path.join(path.resolve(r), id))
})
for (const [name, id] of [
  ['DotDot', '..'], ['DotDotSlash', '../x'], ['Empty', ''], ['SingleDot', '.'], ['Nested', 'a/b'],
  ['BackslashTraversal', '..\\x'], ['NulByte', 'a\0b'], ['AbsolutePath', path.resolve('/etc')],
] as const) {
  test(`resolveSessionDir_${name}_ReturnsNull`, () => assert.equal(resolveSessionDir(root(), id), null))
}

test('readBodyLimited_UnderLimit_ReturnsBody', async () => {
  const req = fakeReq()
  const p = readBodyLimited(req, 100, 1000)
  req.emit('data', Buffer.from('{"a":1}')); req.emit('end')
  assert.equal(await p, '{"a":1}')
})
test('readBodyLimited_OverLimit_RejectsPayloadTooLarge', async () => {
  const req = fakeReq()
  const p = readBodyLimited(req, 5, 1000)
  req.emit('data', Buffer.from('123456'))
  await assert.rejects(p, PayloadTooLargeError)
})
test('readBodyLimited_StalledClient_RejectsTimeout', async () => {
  await assert.rejects(readBodyLimited(fakeReq(), 100, 30), RequestTimeoutError)
})
test('readBodyLimited_Aborted_Rejects', async () => {
  const req = fakeReq()
  const p = readBodyLimited(req, 100, 1000)
  req.emit('aborted')
  await assert.rejects(p)
})
