import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmTx, confirmationsFor, describeOutcome } from '../tx.mjs'

const notFound = () => Object.assign(new Error('no receipt'), { name: 'TransactionReceiptNotFoundError' })
const receipt = (status, blockNumber = 10n, blockHash = '0xb1') => ({ status, blockNumber, blockHash, transactionHash: '0xa' })
// receipts: what successive getTransactionReceipt calls return (null = not found); the last one repeats.
function fake({ receipts = [null], head = 10n, mined = 0, known = false }) {
  let i = 0
  return {
    getTransactionReceipt: async () => { const r = receipts[Math.min(i++, receipts.length - 1)]; if (!r) throw notFound(); return r },
    getBlockNumber: async () => (typeof head === 'function' ? head() : head),
    getTransactionCount: async () => mined,
    getTransaction: async () => { if (!known) throw Object.assign(new Error('not found'), { name: 'TransactionNotFoundError' }); return {} },
  }
}
const fast = { interval: 0, sleep: async () => {} }

test('confirmed and reverted come from the receipt', async () => {
  assert.equal((await confirmTx(fake({ receipts: [receipt('success')] }), '0xa', fast)).status, 'confirmed')
  assert.equal((await confirmTx(fake({ receipts: [receipt('reverted')] }), '0xa', fast)).status, 'reverted')
})

test('waits for the required confirmations', async () => {
  let head = 10n
  const pub = fake({ receipts: [receipt('success')], head: () => head++ })
  const o = await confirmTx(pub, '0xa', { ...fast, confirmations: 3 })
  assert.equal(o.status, 'confirmed'); assert.ok(head >= 12n, 'the head moved two blocks past the receipt')
})

test('a receipt moved by a reorg is not reported until it settles again', async () => {
  const pub = fake({ receipts: [receipt('success', 10n, '0xold'), receipt('success', 11n, '0xnew')], head: 11n })
  const o = await confirmTx(pub, '0xa', fast)
  assert.equal(o.receipt.blockHash, '0xnew')
})

test('the slot used by another transaction means replaced; ours landing late is not', async () => {
  assert.deepEqual(await confirmTx(fake({ mined: 5 }), '0xa', { ...fast, from: '0x1', nonce: 4 }), { status: 'replaced', reason: 'unknown', hash: '0xa' })
  const late = fake({ receipts: [null, receipt('success')], mined: 5 })
  assert.equal((await confirmTx(late, '0xa', { ...fast, from: '0x1', nonce: 4 })).status, 'confirmed')
})

test('a forgotten transaction with an unused slot is dropped; one still pending is never called dropped', async () => {
  assert.deepEqual(await confirmTx(fake({ mined: 4 }), '0xa', { ...fast, from: '0x1', nonce: 4, timeout: 0 }), { status: 'dropped', hash: '0xa' })
  await assert.rejects(confirmTx(fake({ mined: 4, known: true }), '0xa', { ...fast, from: '0x1', nonce: 4, timeout: 0 }), /still pending/)
})

test('RPC errors are not swallowed', async () => {
  const pub = { getTransactionReceipt: async () => { throw new Error('RPC down') } }
  await assert.rejects(confirmTx(pub, '0xa', fast), /RPC down/)
})

test('confirmation policy: 1 locally, 3 elsewhere, overridable and bounded', () => {
  assert.equal(confirmationsFor({ chainId: 31337 }, {}), 1)
  assert.equal(confirmationsFor({ chainId: 1301 }, {}), 3)
  assert.equal(confirmationsFor({ chainId: 1301 }, { CLIENT_CONFIRMATIONS: '12' }), 12)
  for (const bad of ['0', '65', '1.5', 'x']) assert.throws(() => confirmationsFor({ chainId: 1 }, { CLIENT_CONFIRMATIONS: bad }))
})

test('every outcome has a next step', () => {
  for (const o of [{ status: 'confirmed', receipt: receipt('success') }, { status: 'reverted', receipt: receipt('reverted') }, { status: 'dropped', hash: '0xa' }, { status: 'replaced', reason: 'unknown', hash: '0xa' }]) {
    assert.match(describeOutcome('withdraw', o), /^withdraw .+/)
  }
})

test('transaction lookup transport errors remain uncertain rather than dropped', async () => {
  for (const message of ['RPC 503 unavailable', 'request timed out']) {
    const pub = fake({})
    pub.getTransaction = async () => { throw new Error(message) }
    await assert.rejects(confirmTx(pub, '0xa', { ...fast, from: '0x1', nonce: 0, timeout: 0 }), { message })
  }
})
