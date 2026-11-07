import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { batchFromRow, createArkiv, mirrorSettled, publicBatch, recentBatches } from '../index.mjs'

const settled = {
  batchId: '7',
  clearingPrice: '1.5',
  orderCount: '3',
  settleTx: '0x' + 'ab'.repeat(32),
  pair: 'TKA/TKB',
}

const fileEnv = () => ({ ARKIV: 'off', ARKIV_FILE: join(mkdtempSync(join(tmpdir(), 'blindfold-arkiv-')), 'arkiv-local.json') })

test('a settled batch round-trips through the file and drops private fields', async () => {
  const arkiv = createArkiv(fileEnv())
  await mirrorSettled([settled], arkiv)
  const [row] = await recentBatches(arkiv)
  assert.equal(row.batchId, '7')
  assert.equal(row.settleTx, settled.settleTx)
  assert.equal(row.order, undefined)
})

test('a later store reads the same file, newest first', async () => {
  const env = fileEnv()
  await mirrorSettled([settled], createArkiv(env))
  await mirrorSettled([{ ...settled, batchId: '8' }], createArkiv(env))
  const rows = await recentBatches(createArkiv(env))
  assert.deepEqual(rows.map((row) => row.batchId), ['8', '7'])
})

test('private order data is refused', () => {
  assert.throws(() => publicBatch({ ...settled, ciphertext: '0x01' }), /private order data/)
})

test('ARKIV=off stays available without a key, and a missing testnet is unavailable', async () => {
  assert.equal(createArkiv(fileEnv()).unavailable, false)
  const down = createArkiv({ ARKIV: 'testnet' })
  assert.equal(down.unavailable, true)
  await assert.rejects(recentBatches(down), /history unavailable/)
})

test('the sdk adapter stores public fields and a down client becomes history unavailable', async () => {
  const written = []
  const sdk = async () => ({
    async create(attrs) { written.push(attrs) },
    async query() {
      return written.map((attrs, index) => ({ ...attrs, createdAt: BigInt(index) })).map(({ createdAt, ...row }) => row)
    },
  })
  const env = { ARKIV: 'testnet', ARKIV_RPC: 'http://127.0.0.1:9', ARKIV_KEY: `0x${'11'.repeat(32)}` }
  const arkiv = createArkiv(env, { sdk })
  await mirrorSettled([settled, { ...settled, batchId: '9' }], arkiv)
  assert.equal(written[0].pair, 'TKA/TKB')
  assert.equal(written[0].ciphertext, undefined)
  assert.deepEqual((await recentBatches(arkiv)).map((row) => row.batchId), ['9', '7'])
  const down = createArkiv(env, { sdk: async () => { throw new Error(`refused ${env.ARKIV_KEY}`) } })
  await assert.rejects(recentBatches(down), (error) => error.message === 'history unavailable')
})

test('query rows unwrap Arkiv values and sort oldest first before the recent-batches reverse', () => {
  const older = batchFromRow({
    $createdAt: 1n,
    batchId: { value: 7n },
    pair: { value: 'TKA/TKB' },
    clearingPrice: { value: '1' },
    orderCount: { value: 2n },
    settleTx: { value: '0xabc' },
  })
  const newer = batchFromRow({ $createdAt: 3n, batchId: '9', pair: 'TKA/TKB', clearingPrice: '2', orderCount: '1', settleTx: '0xdef' })
  const rows = [newer, older].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  assert.deepEqual(rows.map((row) => row.batchId), ['7', '9'])
  assert.equal(older.clearingPrice, '1')
})
