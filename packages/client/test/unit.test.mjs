import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { decrypt, drandClient, encrypt, orderHash, encodePayload, decodePayload } from '../lib.mjs'
import { balances, exitPlan, preflight, track, isOpen } from '../flow.mjs'

const fixture = fileURLToPath(new URL('./fixtures/drand.json', import.meta.url))
const owner = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const order = { owner, zeroForOne: true, amountIn: 10n ** 18n, minAmountOut: 9n * 10n ** 17n }
const salt = `0x${'03'.repeat(32)}`

test('orderHash matches cast abi-encode + cast keccak', () => {
  // cast keccak $(cast abi-encode "f(uint256,address,uint64,(address,bool,uint128,uint128),bytes32)" 31337 \
  //   0x5FbDB2315678afecb367f032d93F642f64180aa3 7 "(0x7099…79C8,true,1000000000000000000,900000000000000000)" 0x0303…03)
  assert.equal(orderHash(31337, '0x5FbDB2315678afecb367f032d93F642f64180aa3', 7n, order, salt),
    '0x3562821b3a92f6debe561e97b33e4669f19c539dce2cc1f74314fd18fb816aa6')
})

test('payload round-trips through abi.encode(order, salt)', () => {
  assert.deepEqual(decodePayload(encodePayload(order, salt)), { order, salt })
})

test('tlock: encrypt to a recorded quicknet round, decrypt with its signature', async () => {
  const drand = drandClient(fixture)
  const ct = await encrypt(1000000, order, salt, drand)
  assert.match(ct, /^0x[0-9a-f]+$/)
  assert.deepEqual(await decrypt(ct, drand), { order, salt })
})

test('tlock: a round that is not out yet does not decrypt', async () => {
  const drand = drandClient(fixture)
  const ct = await encrypt(1000001, order, salt, drand)
  await assert.rejects(decrypt(ct, drand), /not recorded/)
})

test('balances: any open commitment makes nothing withdrawable', () => {
  assert.deepEqual(balances({ balance: 100n, locked: 30n, open: 0n }), { available: 70n, reserved: 30n, withdrawable: 70n })
  assert.deepEqual(balances({ balance: 100n, locked: 0n, open: 1n }), { available: 100n, reserved: 0n, withdrawable: 0n })
})

const T0 = '0x0000000000000000000000000000000000000a00'
const T1 = '0x0000000000000000000000000000000000000b00'
const base = {
  order, tokenIn: T0, depositToken: T1, depositAmount: 5n, fee: 1n,
  free: { [T0]: order.amountIn, [T1]: 6n }, wallet: { [T0]: 0n, [T1]: 0n }, allowance: { [T0]: 0n, [T1]: 0n },
  batch: { id: 3n, current: 3n, commitsClose: 100n, now: 80n, commits: 0n, maxCommits: 64n },
}

test('preflight: funded order passes and needs no deposit', () => {
  const r = preflight(base)
  assert.ok(r.ok, r.problems.join())
  assert.deepEqual(r.funding.map((f) => f.shortfall), [0n, 0n])
})

test('preflight: checks every asset, deposit and fee included', () => {
  const r = preflight({ ...base, free: { [T0]: 0n, [T1]: 5n } })
  assert.ok(!r.ok)
  assert.equal(r.problems.length, 2) // token0 for the order, token1 for deposit + fee
  const r2 = preflight({ ...base, free: { [T0]: 0n, [T1]: 5n }, wallet: { [T0]: order.amountIn, [T1]: 1n }, allowance: { [T0]: 0n, [T1]: 1n } })
  assert.ok(r2.ok, r2.problems.join())
  assert.deepEqual(r2.funding.map((f) => [f.shortfall, f.approve]), [[1n, 0n], [order.amountIn, order.amountIn]])
})

test('preflight: input and deposit in the same token add up', () => {
  const r = preflight({ ...base, tokenIn: T1, free: { [T0]: 0n, [T1]: order.amountIn + 5n } })
  assert.ok(!r.ok)
  assert.equal(r.funding[0].need, order.amountIn + 6n)
})

test('preflight: batch eligibility', () => {
  assert.match(preflight({ ...base, batch: { ...base.batch, current: 4n } }).problems[0], /not open/)
  assert.match(preflight({ ...base, batch: { ...base.batch, commits: 64n } }).problems[0], /full/)
  assert.match(preflight({ ...base, batch: { ...base.batch, now: 98n } }).problems[0], /closes in 2s/)
  assert.match(preflight({ ...base, order: { ...order, minAmountOut: 0n } }).problems[0], /no price protection/)
})

test('track: follows each commitment to its outcome', () => {
  const ev = (eventName, args) => ({ eventName, args })
  const other = '0x0000000000000000000000000000000000000001'
  const o = (amountIn) => ({ ...order, amountIn })
  const mine = track([
    ev('Committed', { commitId: 0n, batchId: 1n, committer: owner, round: 9n }),
    ev('Committed', { commitId: 1n, batchId: 1n, committer: owner, round: 9n }),
    ev('Committed', { commitId: 2n, batchId: 1n, committer: other, round: 9n }),
    ev('Committed', { commitId: 3n, batchId: 1n, committer: owner, round: 9n }),
    ev('Committed', { commitId: 4n, batchId: 2n, committer: owner, round: 12n }),
    ev('Committed', { commitId: 5n, batchId: 2n, committer: owner, round: 12n }),
    ev('Committed', { commitId: 6n, batchId: 2n, committer: owner, round: 12n }),
    ev('Revealed', { commitId: 0n, batchId: 1n, order: o(5n) }),
    ev('Revealed', { commitId: 1n, batchId: 1n, order: o(0n) }),
    ev('Slashed', { commitId: 3n, batchId: 1n }),
    ev('Revealed', { commitId: 4n, batchId: 2n, order: o(7n) }),
    ev('RevealedUnfunded', { commitId: 5n, batchId: 2n, order: o(7n) }),
    ev('Filled', { batchId: 1n, id: 0n, owner, amountIn: 5n, amountOut: 4n }),
    ev('Expired', { batchId: 2n, orders: 1n }),
  ], owner.toLowerCase())
  assert.deepEqual([...mine.values()].map((c) => [c.id, c.state]),
    [[0n, 'filled'], [1n, 'padding'], [3n, 'slashed'], [4n, 'expired'], [5n, 'unfunded'], [6n, 'committed']])
  assert.deepEqual([...mine.values()].filter(isOpen).map((c) => c.id), [6n])
})

test('S4 exitPlan: the step that clears each open commitment', () => {
  const sched = new Map([[1n, { revealOpens: 100n, revealCloses: 124n, settleCloses: 184n }]])
  const c = (id, state) => ({ id, batchId: 1n, state, hash: `0x${id}` })
  const plan = (now, saved = new Set(['0x1'])) =>
    exitPlan([c(1n, 'committed'), c(2n, 'committed'), c(3n, 'revealed')], { now, sched, saved }).map((s) => [s.action, s.at])
  assert.deepEqual(plan(90n), [['wait', 100n], ['wait', 100n], ['wait', 184n]])
  assert.deepEqual(plan(110n), [['reveal', undefined], ['wait', 124n], ['wait', 184n]]) // #2 has no saved order
  assert.deepEqual(plan(124n), [['slash', undefined], ['slash', undefined], ['wait', 184n]])
  assert.deepEqual(plan(184n), [['slash', undefined], ['slash', undefined], ['expire', undefined]])
})
