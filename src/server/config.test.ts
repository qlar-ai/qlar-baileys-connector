import { test } from 'node:test'
import assert from 'node:assert/strict'
import { requireHubUrl } from './config'

test('requireHubUrl_HubUrlSet_ReturnsTrimmed', () => {
  assert.equal(requireHubUrl({ HUB_URL: ' https://h/hubs/connector \r\n' }), 'https://h/hubs/connector')
})
test('requireHubUrl_OnlyLegacyVarSet_ReturnsIt', () => {
  assert.equal(requireHubUrl({ MESSENGER_BE_HUB_URL: 'https://legacy/hubs/connector' }), 'https://legacy/hubs/connector')
})
test('requireHubUrl_NeitherSet_Throws', () => {
  assert.throws(() => requireHubUrl({}), /HUB_URL is not set/)
})
test('requireHubUrl_BlankString_Throws', () => {
  assert.throws(() => requireHubUrl({ HUB_URL: '  \r\n' }), /HUB_URL is not set/)
})
