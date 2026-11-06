import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createArkiv, mirrorSettled, publicBatch, recentBatches } from '../index.mjs'

const settled = {
  batchId: '7',
  clearingPrice: '1.5',
  orderCount: '3',
  settleTx: '0x' + 'ab'.repeat(32),
  pair: 'TKA/TKB',
}

test('a settled batch round-trips in memory and drops private fields', async () => {
  const arkiv = createArkiv({ ARKIV: 'off' })
  await mirrorSettled([settled], arkiv)
  const [row] = await recentBatches(arkiv)
  assert.equal(row.batchId, '7')
  assert.equal(row.settleTx, settled.settleTx)
  assert.equal(row.order, undefined)
})

test('private order data is refused', () => {
  assert.throws(() => publicBatch({ ...settled, ciphertext: '0x01' }), /private order data/)
})

test('ARKIV=off stays available without a key, and a missing testnet is unavailable', async () => {
  assert.equal(createArkiv({}).unavailable, false)
  const down = createArkiv({ ARKIV: 'testnet' })
  assert.equal(down.unavailable, true)
  await assert.rejects(recentBatches(down), /history unavailable/)
})
