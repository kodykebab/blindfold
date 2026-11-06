import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mirrorSettlement } from '../mirror.mjs'

test('a throwing Arkiv does not fail the settlement', async () => {
  const logs = []
  const fields = {
    batchId: '4',
    pair: '0x1111111111111111111111111111111111111111/0x2222222222222222222222222222222222222222',
    clearingPrice: '79228162514264337593543950336',
    orderCount: '2',
    settleTx: `0x${'ab'.repeat(32)}`,
  }
  await mirrorSettlement(fields, { async put() { throw new Error('arkiv down') } }, (line) => logs.push(line))
  assert.equal(logs.length, 1)
  assert.match(logs[0], /arkiv mirror failed for batch 4: arkiv down/)
})
