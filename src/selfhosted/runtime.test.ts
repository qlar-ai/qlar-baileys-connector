import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertNodeVersion, connectorVersion, describeFailure, isCodeRejection } from './runtime'

test('assertNodeVersion_22_ThrowsWithFoundVersion', () => {
  assert.throws(() => assertNodeVersion('22.1.0'), /Node 24 or newer is required, found v22\.1\.0/)
})
test('assertNodeVersion_24_Passes', () => assert.doesNotThrow(() => assertNodeVersion('24.0.0')))
test('assertNodeVersion_AcceptsLeadingV', () => {
  assert.doesNotThrow(() => assertNodeVersion('v25.2.1'))
  assert.throws(() => assertNodeVersion('v20.0.0'), /found v20\.0\.0/)
})
test('connectorVersion_EnvSet_ReturnsIt', () => assert.equal(connectorVersion({ CONNECTOR_VERSION: '1.1.0' }), '1.1.0'))
test('connectorVersion_NothingSet_ReturnsDev', () => assert.equal(connectorVersion({}), 'dev'))
test('describeFailure_InvalidCode_MentionsCms', () => {
  assert.match(describeFailure(new Error('Pairing code invalid or expired'), 'https://h'), /new code in the Qlar CMS/i)
})
test('describeFailure_ConnectionRefused_NamesHub', () => {
  const err = Object.assign(new Error('connect ECONNREFUSED 1.2.3.4:443'), { code: 'ECONNREFUSED' })
  assert.match(describeFailure(err, 'https://hub.example/hubs/connector'), /https:\/\/hub\.example\/hubs\/connector/)
})

test('isCodeRejection_InvalidOrExpired_True', () => {
  assert.equal(isCodeRejection(new Error('Pairing code invalid or expired')), true)
})
test('isCodeRejection_ConnectionError_False', () => {
  assert.equal(isCodeRejection(new Error('connect ECONNREFUSED 1.2.3.4:443')), false)
})
test('describeFailure_InvalidCode_TellsDockerUsersToRemoveTheOldContainer', () => {
  assert.match(describeFailure(new Error('invalid or expired'), 'https://h'), /docker rm -f qlar-connector/)
})
