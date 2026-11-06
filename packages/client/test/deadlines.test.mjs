// Batch-deadline boundaries: what the client offers at each second around every deadline, checked against the
// contract's comparisons in BatchAuction.sol and BlindfoldSettlement.expire. A transaction the client sends at chain
// time `now` lands at now + 1 or later.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deadlines, exitPlan, preflight } from '../flow.mjs'

// One batch: commits close at 100, its drand round is out at 106, reveals close at 130, settlement closes at 160.
const S = { commitsClose: 100n, revealOpens: 106n, revealCloses: 130n, settleCloses: 160n }
const sched = new Map([[0n, S]])
const T0 = '0x0000000000000000000000000000000000000a00'
const T1 = '0x0000000000000000000000000000000000000b00'
const order = { owner: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', zeroForOne: true, amountIn: 10n, minAmountOut: 9n }

// Contract rules, written out from the Solidity, as the reference the client must agree with.
const contract = {
  commit: (t) => t < S.commitsClose, // currentBatch() == batchId  ⇔  t < commitsClose
  reveal: (t) => t >= S.revealOpens && t < S.revealCloses, // OutsideRevealWindow unless opens <= t < closes
  slash: (t) => t >= S.revealCloses, // RevealWindowOpen while t < closes
  expire: (t) => t >= S.settleCloses, // NotExpired while t < settleCloses
}

const commitCheck = (now, extra = {}) => preflight({
  order, tokenIn: T0, depositToken: T1, depositAmount: 5n, fee: 0n,
  free: { [T0]: 10n, [T1]: 5n }, wallet: { [T0]: 0n, [T1]: 0n }, allowance: { [T0]: 0n, [T1]: 0n },
  batch: { id: 0n, current: 0n, commitsClose: S.commitsClose, now, commits: 0n, maxCommits: 64n }, minLead: 0n, ...extra,
})
const plan = (state, now, { saved = true, admissionRequired = false } = {}) => {
  const c = { id: 0n, batchId: 0n, state, hash: '0x01' }
  const [step] = exitPlan([c], { now, sched, saved: new Set(saved ? ['0x01'] : []), admissionRequired })
  return step.action === 'wait' ? `wait ${step.at}` : step.action
}

test('deadlines lists the four boundaries in order, with the policy for unrevealed commitments', () => {
  for (const admission of [false, true]) {
    const d = deadlines(S, admission)
    assert.deepEqual(d.map((x) => x.at), [100n, 106n, 130n, 160n])
    assert.match(d[0].what, /commits close/)
    assert.match(d[1].what, /anyone can reveal/)
    assert.match(d[2].what, admission ? /released \(fee retained\)/ : /slashed \(deposit lost\)/)
    assert.match(d[3].what, /expire the batch/)
  }
})

test('commit: allowed only while the transaction still lands before commitsClose', () => {
  // chain time → would the commit land in time (contract) → does preflight allow it
  for (const now of [97n, 98n, 99n, 100n]) {
    const allowed = commitCheck(now).ok
    assert.equal(allowed, contract.commit(now + 1n), `now ${now}`)
  }
  assert.ok(commitCheck(98n).ok, 'commitsClose − 2: lands at commitsClose − 1, accepted')
  assert.match(commitCheck(99n).problems[0], /closes in 1s/, 'commitsClose − 1: would land at commitsClose')
  assert.match(commitCheck(100n).problems[0], /closes in 0s/)
  // at commitsClose the chain has moved on: the CLI's current batch is the next one, so batch 0 is not open
  assert.match(commitCheck(100n, { batch: { id: 0n, current: 1n, commitsClose: S.commitsClose, now: 100n, commits: 0n, maxCommits: 64n } }).problems[0], /not open/)
  assert.match(commitCheck(101n, { batch: { id: 0n, current: 1n, commitsClose: S.commitsClose, now: 101n, commits: 0n, maxCommits: 64n } }).problems[0], /not open/)
})

test('commit: each funding transaction before the commit moves the last safe second earlier', () => {
  // vault empty: approve + deposit for token0, deposit for token1 (approved) → three blocks before the commit
  const unfunded = { free: { [T0]: 0n, [T1]: 0n }, wallet: { [T0]: 10n, [T1]: 5n }, allowance: { [T0]: 0n, [T1]: 5n } }
  assert.deepEqual(commitCheck(95n, unfunded).funding.map((f) => [f.shortfall > 0n, f.approve > 0n]), [[true, false], [true, true]])
  assert.ok(commitCheck(95n, unfunded).ok, 'lands at 99 after three funding blocks')
  assert.match(commitCheck(96n, unfunded).problems[0], /closes in 4s/, 'would land at commitsClose')
  // the configured margin still applies on top of the floor
  assert.match(commitCheck(90n, { minLead: 11n }).problems[0], /closes in 10s/)
  assert.ok(commitCheck(89n, { minLead: 11n }).ok)
})

test('exitPlan agrees with the contract at every second around each boundary, admission off', () => {
  const at = (now) => [plan('committed', now), plan('committed', now, { saved: false }), plan('revealed', now)]
  assert.deepEqual(at(99n), ['wait 106', 'wait 106', 'wait 160']) // commitsClose − 1
  assert.deepEqual(at(100n), ['wait 106', 'wait 106', 'wait 160']) // commitsClose
  assert.deepEqual(at(101n), ['wait 106', 'wait 106', 'wait 160']) // commitsClose + 1
  assert.deepEqual(at(105n), ['wait 106', 'wait 106', 'wait 160']) // revealOpens − 1
  assert.deepEqual(at(106n), ['reveal', 'wait 130', 'wait 160']) // revealOpens
  assert.deepEqual(at(107n), ['reveal', 'wait 130', 'wait 160'])
  assert.deepEqual(at(128n), ['reveal', 'wait 130', 'wait 160']) // lands at revealCloses − 1
  assert.deepEqual(at(129n), ['wait 130', 'wait 130', 'wait 160']) // revealCloses − 1: a reveal would land too late
  assert.deepEqual(at(130n), ['slash', 'slash', 'wait 160']) // revealCloses
  assert.deepEqual(at(131n), ['slash', 'slash', 'wait 160'])
  assert.deepEqual(at(159n), ['slash', 'slash', 'wait 160']) // settleCloses − 1
  assert.deepEqual(at(160n), ['slash', 'slash', 'expire']) // settleCloses
  assert.deepEqual(at(161n), ['slash', 'slash', 'expire'])
})

test('exitPlan with admission: a missed reveal is released, never slashed, at the same boundaries', () => {
  const at = (now) => [plan('committed', now, { admissionRequired: true }), plan('committed', now, { saved: false, admissionRequired: true }), plan('revealed', now, { admissionRequired: true })]
  assert.deepEqual(at(105n), ['wait 106', 'wait 106', 'wait 160'])
  assert.deepEqual(at(106n), ['reveal', 'wait 130', 'wait 160'])
  assert.deepEqual(at(128n), ['reveal', 'wait 130', 'wait 160'])
  assert.deepEqual(at(129n), ['wait 130', 'wait 130', 'wait 160'])
  assert.deepEqual(at(130n), ['release', 'release', 'wait 160'])
  assert.deepEqual(at(159n), ['release', 'release', 'wait 160'])
  assert.deepEqual(at(160n), ['release', 'release', 'expire'])
  const c = { id: 0n, batchId: 0n, state: 'committed', hash: '0x01' }
  assert.match(exitPlan([c], { now: 129n, sched, saved: new Set(['0x01']), admissionRequired: true })[0].why, /released after/)
  assert.match(exitPlan([c], { now: 129n, sched, saved: new Set(['0x01']) })[0].why, /slashed after/)
})

test('every action exitPlan offers would be accepted by the contract when it lands one second later', () => {
  for (let now = 95n; now <= 165n; now++) {
    for (const state of ['committed', 'revealed']) {
      for (const admissionRequired of [false, true]) {
        const action = plan(state, now, { admissionRequired })
        if (action.startsWith('wait')) continue
        const rule = { reveal: contract.reveal, slash: contract.slash, release: contract.slash, expire: contract.expire }[action]
        assert.ok(rule(now) && rule(now + 1n), `${action} offered at ${now} must be valid at ${now} (simulation) and ${now + 1n} (inclusion)`)
      }
    }
  }
})
