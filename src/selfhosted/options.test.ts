import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand, UsageError } from './options'

const HUB = 'https://hub.example/hubs/connector'

test('parseCommand_EnrollWithFlags_ReturnsEnroll', () => {
  assert.deepEqual(parseCommand(['enroll', '--hub', HUB, '--code', 'AB12-CD34', '--state-dir', '/s'], {}), {
    kind: 'enroll', hubUrl: HUB, code: 'AB12-CD34', stateDir: '/s',
  })
})
test('parseCommand_FlagBeatsEnv', () => {
  const cmd = parseCommand(['enroll', '--hub', HUB, '--code', 'FLAG'], { QLAR_HUB_URL: 'https://other', QLAR_PAIRING_CODE: 'ENV' })
  assert.equal(cmd.kind === 'enroll' && cmd.code, 'FLAG')
  assert.equal(cmd.kind === 'enroll' && cmd.hubUrl, HUB)
})
test('parseCommand_EnvOnly_ReturnsValues', () => {
  assert.deepEqual(
    parseCommand(['enroll'], { QLAR_HUB_URL: HUB, QLAR_PAIRING_CODE: 'AB12', CONNECTOR_DATA_DIR: '/state' }),
    { kind: 'enroll', hubUrl: HUB, code: 'AB12', stateDir: '/state' },
  )
})
test('parseCommand_TrailingSpaceAndCrlfFromWindowsEcho_AreTrimmed', () => {
  const cmd = parseCommand(['enroll'], { QLAR_HUB_URL: `${HUB} \r`, QLAR_PAIRING_CODE: 'AB12 \r' })
  assert.deepEqual(cmd, { kind: 'enroll', hubUrl: HUB, code: 'AB12', stateDir: './state' })
})
test('parseCommand_EmptyHub_ThrowsUsageError', () => {
  assert.throws(() => parseCommand(['run'], { QLAR_HUB_URL: '  \r' }), (e: unknown) => e instanceof UsageError && /hub URL/i.test((e as Error).message))
})
test('parseCommand_UnknownCommand_ThrowsUsageError', () => {
  assert.throws(() => parseCommand(['start'], {}), (e: unknown) => e instanceof UsageError && /enroll.*run.*version/.test((e as Error).message))
  assert.throws(() => parseCommand([], {}), UsageError)
})
test('parseCommand_Version_NeedsNoHub', () => {
  assert.deepEqual(parseCommand(['version'], {}), { kind: 'version' })
})
test('parseCommand_StateDirDefault_IsDotState', () => {
  const cmd = parseCommand(['run', '--hub', HUB], {})
  assert.deepEqual(cmd, { kind: 'run', hubUrl: HUB, stateDir: './state' })
})
