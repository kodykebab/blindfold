import { test } from 'node:test'
import assert from 'node:assert/strict'
import { confirmTx, confirmationsFor, describeOutcome } from '../tx.mjs'

const timeoutError = () => Object.assign(new Error('timed out'), { name: 'WaitForTransactionReceiptTimeoutError' })
const receipt = (status, transactionHash = '0xa') => ({ status, transactionHash })
const fake = ({ wait, known = false, mined = 0 }) => ({
  waitForTransactionReceipt: wait,
  getTransaction: async () => { if (!known) throw new Error('not found'); return {} },
  getTransactionCount: async () => mined,
})

test('confirmed and reverted come straight from the receipt', async () => {
  assert.equal((await confirmTx(fake({ wait: async () => receipt('success') }), '0xa')).status, 'confirmed')
  assert.equal((await confirmTx(fake({ wait: async () => receipt('reverted') }), '0xa')).status, 'reverted')
})

test('a repriced transaction counts as the same transaction', async () => {
  const wait = async ({ onReplaced }) => { onReplaced({ reason: 'repriced', transaction: { hash: '0xb' } }); return receipt('success', '0xb') }
  const o = await confirmTx(fake({ wait }), '0xa')
  assert.equal(o.status, 'confirmed'); assert.equal(o.receipt.transactionHash, '0xb')
})

test('a cancelled or replaced transaction is reported with the replacement', async () => {
  for (const reason of ['cancelled', 'replaced']) {
    const wait = async ({ onReplaced }) => { onReplaced({ reason, transaction: { hash: '0xc' } }); return receipt('success', '0xc') }
    assert.deepEqual(await confirmTx(fake({ wait }), '0xa'), { status: 'replaced', reason, receipt: receipt('success', '0xc'), hash: '0xc' })
  }
})

test('a vanished transaction is dropped while its nonce is unused, replaced once it is used', async () => {
  const wait = async () => { throw timeoutError() }
  assert.equal((await confirmTx(fake({ wait, mined: 4 }), '0xa', { from: '0x1', nonce: 4 })).status, 'dropped')
  assert.deepEqual(await confirmTx(fake({ wait, mined: 5 }), '0xa', { from: '0x1', nonce: 4 }), { status: 'replaced', reason: 'unknown', hash: '0xa' })
})

test('a transaction the node still holds is never called dropped', async () => {
  const wait = async () => { throw timeoutError() }
  await assert.rejects(confirmTx(fake({ wait, known: true }), '0xa', { from: '0x1', nonce: 4, timeout: 1000 }), /still pending/)
})

test('other errors are not swallowed', async () => {
  await assert.rejects(confirmTx(fake({ wait: async () => { throw new Error('RPC down') } }), '0xa'), /RPC down/)
})

test('confirmation policy: 1 locally, 3 elsewhere, overridable and bounded', () => {
  assert.equal(confirmationsFor({ chainId: 31337 }, {}), 1)
  assert.equal(confirmationsFor({ chainId: 1301 }, {}), 3)
  assert.equal(confirmationsFor({ chainId: 1301 }, { CLIENT_CONFIRMATIONS: '12' }), 12)
  for (const bad of ['0', '65', '1.5', 'x']) assert.throws(() => confirmationsFor({ chainId: 1 }, { CLIENT_CONFIRMATIONS: bad }))
})

test('every outcome has a next step', () => {
  for (const o of [{ status: 'confirmed', receipt: receipt('success') }, { status: 'reverted', receipt: receipt('reverted') }, { status: 'dropped', hash: '0xa' },
    { status: 'replaced', reason: 'cancelled', hash: '0xa' }, { status: 'replaced', reason: 'unknown', hash: '0xa' }]) {
    assert.match(describeOutcome('withdraw', o), /^withdraw /)
  }
})
