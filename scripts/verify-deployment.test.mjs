// Offline checks for verify-deployment's bytecode comparison.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCode, sameCode } from './verify-deployment.mjs'

// 6 bytes of code, a 4-byte immutable at offset 2, then CBOR metadata of 3 bytes plus its 2-byte length.
const artifact = { object: '0x6000000000005b' + 'a1b2c3' + '0003', immutableReferences: { 7: [{ start: 2, length: 4 }] } }

test('immutables and the metadata hash are masked, everything else must match', () => {
  assert.equal(normalizeCode(artifact.object, artifact.immutableReferences), '60000000000' + '05b')
  assert.ok(sameCode('0x6000deadbeef5b' + 'ffffff' + '0003', artifact), 'other immutable values and metadata still match')
  assert.ok(!sameCode('0x6100deadbeef5b' + 'a1b2c3' + '0003', artifact), 'a changed opcode does not')
  assert.ok(!sameCode('0x', artifact), 'no code never matches')
  assert.ok(!sameCode(undefined, artifact))
})
