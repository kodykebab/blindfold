import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { BaseError, ContractFunctionRevertedError, encodeErrorResult } from 'viem'
import { decrypt, drandClient, encrypt, loadAbi, orderHash } from '../../client/lib.mjs'
import { canSpend, due, lostRace, opened, revertName } from '../work.mjs'

const owner = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const settlement = '0x5FbDB2315678afecb367f032d93F642f64180aa3'
const order = { owner, zeroForOne: true, amountIn: 10n, minAmountOut: 9n }
const salt = `0x${'03'.repeat(32)}`

test('due: reveal inside the window, slash after it, expire unsettled batches with orders', () => {
  const batches = new Map([
    [1n, { revealOpens: 100n, revealCloses: 124n, settleCloses: 184n, finalized: false, orders: 2n }],
    [2n, { revealOpens: 130n, revealCloses: 154n, settleCloses: 214n, finalized: false, orders: 0n }],
    [3n, { revealOpens: 0n, revealCloses: 1n, settleCloses: 2n, finalized: true, orders: 1n }],
  ])
  const cs = [
    { id: 0n, batchId: 1n, status: 1 }, { id: 1n, batchId: 1n, status: 2 }, { id: 2n, batchId: 2n, status: 1 },
  ]
  const ids = (w) => ({ reveal: w.reveal.map((c) => c.id), slash: w.slash.map((c) => c.id), expire: w.expire })
  assert.deepEqual(ids(due(cs, batches, 99n)), { reveal: [], slash: [], expire: [] })
  assert.deepEqual(ids(due(cs, batches, 110n)), { reveal: [0n], slash: [], expire: [] })
  assert.deepEqual(ids(due(cs, batches, 140n)), { reveal: [2n], slash: [0n], expire: [] })
  assert.deepEqual(ids(due(cs, batches, 184n)), { reveal: [], slash: [0n, 2n], expire: [1n] }) // batch 2 has no orders, 3 is final
})

test('opened: only a payload that matches its commitment becomes a reveal', () => {
  const c = { id: 7n, batchId: 4n, committer: owner, hash: orderHash(31337, settlement, 4n, order, salt) }
  const ctx = { chainId: 31337, settlement, orderHash }
  assert.deepEqual(opened(c, { order, salt }, ctx), { ok: true, args: [7n, order, salt] })
  assert.match(opened(c, { order, salt: `0x${'04'.repeat(32)}` }, ctx).why, /does not match/)
  assert.match(opened({ ...c, committer: settlement }, { order, salt }, ctx).why, /not the committer/)
})

test('a round that is not out waits; a garbage ciphertext never decrypts', async () => {
  const drand = drandClient(fileURLToPath(new URL('../../client/test/fixtures/drand.json', import.meta.url)))
  await assert.rejects(drand.get(1000001), /not recorded/)
  const ct = await encrypt(1000000, order, salt, drand)
  assert.deepEqual(await decrypt(ct, drand), { order, salt })
  await assert.rejects(decrypt(`0x${'ab'.repeat(200)}`, drand))
})

test('lostRace: BadStatus and Finalized mean another sender landed first', () => {
  const abi = loadAbi('BlindfoldSettlement')
  const err = (errorName, args) => new BaseError('x', {
    cause: new ContractFunctionRevertedError({ abi, functionName: 'reveal', data: encodeErrorResult({ abi, errorName, args }) }),
  })
  assert.equal(revertName(err('BadStatus', [3n])), 'BadStatus')
  assert.ok(lostRace(err('BadStatus', [3n])))
  assert.ok(lostRace(err('Finalized', [1n])))
  assert.ok(!lostRace(err('HashMismatch', [])))
  assert.ok(!lostRace(new Error('rpc down')))
  // undecoded: viem only has the selector
  const raw = (data) => new BaseError('x', { cause: new ContractFunctionRevertedError({ abi: [], functionName: 'reveal', data }) })
  assert.ok(lostRace(raw('0x4a5d4550' + '00'.repeat(32)))) // cast sig "BadStatus(uint256)"
  assert.ok(!lostRace(raw('0x3f4d6053'))) // HashMismatch()
})

test('canSpend: explicit budget and balance floor', () => {
  assert.ok(canSpend({ spent: 5n, budget: 10n, balance: 100n, minBalance: 1n }).ok)
  assert.ok(canSpend({ spent: 5n, budget: null, balance: 100n, minBalance: 1n }).ok)
  assert.match(canSpend({ spent: 10n, budget: 10n, balance: 100n, minBalance: 1n }).why, /budget exhausted/)
  assert.match(canSpend({ spent: 0n, budget: 10n, balance: 0n, minBalance: 1n }).why, /below the 1 wei floor/)
})
