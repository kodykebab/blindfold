import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { account, decrypt, drandClient, encrypt, orderHash, encodePayload, decodePayload } from '../lib.mjs'
import { validateState } from '../state.mjs'
import { balances, deadlines, exitPlan, fillDescription, preflight, track, isOpen } from '../flow.mjs'

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

test('S11 preflight: one active batch per account, checked before any proving or gas', () => {
  assert.ok(preflight({ ...base, openBatches: [3n] }).ok) // more orders in the same batch are fine
  const r = preflight({ ...base, openBatches: [2n, 3n] })
  assert.ok(!r.ok)
  assert.match(r.problems[0], /open commitments in batch 2: one active batch per account/)
})

test('S11 validateState: hashes, owner, deployment and chain state', () => {
  const dep = { chainId: 31337, settlement: '0x5FbDB2315678afecb367f032d93F642f64180aa3' }
  const hash = orderHash(dep.chainId, dep.settlement, 7n, order, salt)
  const entry = { id: 4n, batchId: 7n, order, salt, hash }
  const state = { chainId: dep.chainId, settlement: dep.settlement, owner, commitments: [entry] }
  const check = (s, chain = new Map([[4n, hash]])) => validateState(s, { dep, owner, orderHash, chainHashes: chain })
  assert.deepEqual(check(state), [])
  assert.deepEqual(check({ ...state, commitments: [{ ...entry, id: null }] }, new Map()), []) // saved before its commit landed
  assert.match(check({ ...state, commitments: [{ ...entry, salt: `0x${'04'.repeat(32)}` }] })[0], /do not hash/)
  assert.match(check(state, new Map([[4n, `0x${'00'.repeat(32)}`]]))[0], /stale or foreign/)
  assert.match(check({ ...state, settlement: owner })[0], /another chain or settlement/)
  assert.match(check({ ...state, owner: dep.settlement }).join(), /state belongs to/)
})


test('released commitments close only their own blocker and retain other pending work', () => {
  const args = { committer: owner, batchId: 7n, round: 10n, hash: salt }
  const logs = [0n, 1n].map(commitId => ({ eventName: 'Committed', args: { ...args, commitId } }))
  logs.push({ eventName: 'Released', args: { commitId: 0n } })
  const tracked = track(logs, owner)
  assert.equal(tracked.get(0n).state, 'released')
  assert.equal(isOpen(tracked.get(0n)), false)
  assert.deepEqual([...tracked.values()].filter(isOpen).map(c => c.id), [1n])
})

test('cleanup and deadline text distinguish released deposits from slashing', () => {
  const c = { id: 0n, batchId: 7n, state: 'committed', hash: salt }
  const times = { commitsClose: 5n, revealOpens: 10n, revealCloses: 20n, settleCloses: 30n }
  const context = { now: 20n, sched: new Map([[7n, times]]), saved: new Set() }
  assert.equal(exitPlan([c], context)[0].action, 'slash')
  assert.equal(exitPlan([c], { ...context, admissionRequired: true })[0].action, 'release')
  assert.match(deadlines(times, true)[2].what, /fee retained/)
  assert.match(deadlines(times)[2].what, /deposit lost/)
})


test('local account defaults ignore OS usernames and preserve numeric USER compatibility', () => {
  const expected = account({ CLIENT_ACCOUNT_INDEX: '10' }).address
  assert.equal(account({}).address, expected)
  assert.equal(account({ USER: 'ordinary-local-user' }).address, expected)
  assert.equal(account({ USER: '11' }).address, account({ CLIENT_ACCOUNT_INDEX: '11' }).address)
  assert.equal(account({ USER: '11', CLIENT_ACCOUNT_INDEX: '10' }).address, expected)
  for (const value of ['', '-1', '1.5', 'typo', '2147483648']) {
    assert.throws(() => account({ CLIENT_ACCOUNT_INDEX: value }), /CLIENT_ACCOUNT_INDEX must be/)
  }
})

test('admission preflight reserves cumulative inputs on both sides plus the new fee/deposit', () => {
  const r = preflight({ ...base, cumulative: { [T0]: 100n, [T1]: 50n } })
  assert.equal(r.funding.find((f) => f.token === T0).need, 100n + order.amountIn)
  assert.equal(r.funding.find((f) => f.token === T1).need, 50n + base.depositAmount + base.fee)
  assert.equal(preflight({ ...base, order: { ...order, amountIn: -1n } }).ok, false)
  assert.equal(preflight({ ...base, order: { ...order, amountIn: 1n << 128n } }).ok, false)
})

test('fill descriptions distinguish actual partial and full inputs', () => {
  const format = (token, amount) => `${amount} ${token}`
  const commitment = { state: 'filled', order: { zeroForOne: true, amountIn: 10n }, amountIn: 4n, amountOut: 3n }
  assert.match(fillDescription(commitment, format), /got 3 token1.*partial fill: 4 token0 of 10 token0/)
  assert.match(fillDescription({ ...commitment, amountIn: 10n }, format), /full fill: 10 token0 of 10 token0/)
  assert.equal(fillDescription({ state: 'committed' }, format), '')
})

test('missing local opening describes the deployed unrevealed policy during the reveal window', () => {
  const c = { id: 0n, batchId: 1n, state: 'committed', hash: salt }
  const context = { now: 15n, sched: new Map([[1n, { revealOpens: 10n, revealCloses: 20n, settleCloses: 30n }]]), saved: new Set() }
  assert.match(exitPlan([c], { ...context, admissionRequired: true })[0].why, /deposit can be released/)
  assert.match(exitPlan([c], { ...context, admissionRequired: false })[0].why, /slashed/)
})
