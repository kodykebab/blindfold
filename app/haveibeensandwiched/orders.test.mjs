import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseTrack,
  parseBlockers,
  parseCleanup,
  orderRows,
  orderTitle,
  stageLabel,
  outcomeText,
  nextStep,
  withdrawalSummary,
  policyText,
  formatCountdown,
  formatDuration,
} from './orders.mjs'

test('parse functions extract json from last non-empty line or return error object without throwing', () => {
  const goodTrack = 'some log\n{"policy":{"depositToken":"TKB","depositAmount":"5.0","commitFee":"0.000000000000000001","bountyBps":2000,"admissionRequired":true},"now":1700000000,"orders":[]}\n'
  assert.equal(Array.isArray(parseTrack(goodTrack).orders), true)

  const goodBlockers = 'log line\n{"now":1700000000,"steps":[]}'
  assert.equal(Array.isArray(parseBlockers(goodBlockers).steps), true)

  const goodCleanup = 'log line\n{"dryRun":true,"done":[],"stillBlocking":0}'
  assert.equal(Array.isArray(parseCleanup(goodCleanup).done), true)

  // Bad inputs
  for (const bad of ['', 'not json', '{bad json', null, undefined, '{"wrong":"format"}']) {
    assert.deepEqual(parseTrack(bad), { error: 'unreadable output' })
    assert.deepEqual(parseBlockers(bad), { error: 'unreadable output' })
    assert.deepEqual(parseCleanup(bad), { error: 'unreadable output' })
  }
})

test('table row: committed', () => {
  const order = { id: '0', batch: '1', state: 'committed', blocking: true }
  assert.equal(stageLabel(order), 'Waiting for reveal')
  assert.equal(outcomeText(order), 'Encrypted. A keeper or you reveal it once the drand round for batch 1 is out.')
})

test('table row: revealed', () => {
  const order = { id: '1', batch: '1', state: 'revealed', blocking: true, settleClosesText: '{settleCloses}' }
  assert.equal(stageLabel(order), 'Waiting for settlement')
  assert.equal(outcomeText(order), 'Revealed. The solver settles batch 1 before {settleCloses}.')
})

test('table row: padding', () => {
  const order = { id: '2', batch: '1', state: 'padding', blocking: false }
  assert.equal(stageLabel(order), 'Padding')
  assert.equal(outcomeText(order), 'A zero-size order used to hide your order count. Nothing to trade.')
})

test('table row: unfunded', () => {
  const order = { id: '3', batch: '1', state: 'unfunded', blocking: false }
  assert.equal(stageLabel(order), 'Closed: unfunded')
  assert.equal(outcomeText(order), "The vault didn't hold the input at reveal, so the order was closed and its deposit kept.")
})

test('table row: filled (full)', () => {
  const order = {
    id: '4',
    batch: '1',
    state: 'filled',
    fill: 'full',
    side: 'sell',
    amountIn: '10',
    tokenIn: 'TKA',
    received: '9.8',
    tokenOut: 'TKB',
    blocking: false,
  }
  assert.equal(stageLabel(order), 'Filled')
  assert.equal(outcomeText(order), 'Sold 10 TKA, received 9.8 TKB.')
})

test('table row: filled (partial)', () => {
  const order = {
    id: '5',
    batch: '1',
    state: 'filled',
    fill: 'partial',
    side: 'sell',
    amountIn: '10',
    tokenIn: 'TKA',
    executedIn: '6',
    received: '5.9',
    unusedIn: '4',
    tokenOut: 'TKB',
    blocking: false,
  }
  assert.equal(stageLabel(order), 'Partly filled')
  assert.equal(outcomeText(order), 'Sold 6 of 10 TKA, received 5.9 TKB. 4 TKA unused stays in your vault.')
})

test('table row: unfilled', () => {
  const order = {
    id: '6',
    batch: '1',
    state: 'unfilled',
    amountIn: '10',
    tokenIn: 'TKA',
    unusedIn: '10',
    blocking: false,
  }
  assert.equal(stageLabel(order), 'Not filled')
  assert.equal(outcomeText(order), 'The clearing price was outside your limit. All 10 TKA stays in your vault.')
})

test('table row: slashed', () => {
  const order = { id: '7', batch: '1', state: 'slashed', blocking: false }
  assert.equal(stageLabel(order), 'Slashed')
  assert.equal(outcomeText(order), 'Never revealed, so the deposit was forfeited.')
})

test('table row: released', () => {
  const order = { id: '8', batch: '1', state: 'released', blocking: false }
  assert.equal(stageLabel(order), 'Released')
  assert.equal(outcomeText(order), 'Never revealed. The deposit was returned minus the fee.')
})

test('table row: expired', () => {
  const order = { id: '9', batch: '1', state: 'expired', blocking: false }
  assert.equal(stageLabel(order), 'Expired')
  assert.equal(outcomeText(order), 'The batch was never settled. Your input stays in your vault; run cleanup.')
})

test('titles: sealed order vs revealed order', () => {
  assert.equal(orderTitle({ state: 'committed' }), 'Sealed order')
  assert.equal(
    orderTitle({ side: 'sell', amountIn: '10', tokenIn: 'TKA', minOut: '9', tokenOut: 'TKB' }),
    'Sell 10 TKA for at least 9 TKB'
  )
  assert.equal(
    orderTitle({ side: 'buy', amountIn: '9', tokenIn: 'TKB', minOut: '10', tokenOut: 'TKA' }),
    'Buy 9 TKB for at least 10 TKA'
  )
})

test('next step buttons and sentences', () => {
  const now = 1700000000

  // reveal step
  const reveal = nextStep({ id: '1', blocking: true }, { id: '1', action: 'reveal' }, now)
  assert.equal(reveal.button, 'Reveal now (keeps your bounty)')
  assert.equal(reveal.action, 'reveal')

  // wait step
  const wait = nextStep({ id: '2', blocking: true }, { id: '2', action: 'wait', at: now + 80 }, now)
  assert.equal(wait.button, null)
  assert.equal(wait.text, 'Wait 01:20')

  // cleanup steps
  for (const action of ['release', 'slash', 'expire']) {
    const cleanup = nextStep({ id: '3', blocking: true }, { id: '3', action }, now)
    assert.equal(cleanup.button, 'Clean up')
  }

  // not blocking and no step
  assert.equal(nextStep({ id: '4', blocking: false }, null, now), null)
})

test('countdown and duration formatting', () => {
  assert.equal(formatCountdown(80), '01:20')
  assert.equal(formatCountdown(5), '00:05')
  assert.equal(formatCountdown(0), '00:00')
  assert.equal(formatCountdown(-1), '00:00')

  assert.equal(formatDuration(80), '1m 20s')
  assert.equal(formatDuration(60), '1m')
  assert.equal(formatDuration(45), '45s')
  assert.equal(formatDuration(0), '0s')
})

test('withdrawalSummary with 0, 1, and 2 blockers', () => {
  const now = 1700000000

  // 0 blockers
  assert.equal(withdrawalSummary({ now, orders: [] }, { now, steps: [] }), 'Nothing blocks withdrawal')

  // 1 blocker
  const track1 = {
    now,
    orders: [{ id: '3', state: 'committed', blocking: true }],
  }
  const blockers1 = {
    now,
    steps: [{ id: '3', state: 'committed', action: 'wait', at: now + 80 }],
  }
  assert.equal(
    withdrawalSummary(track1, blockers1),
    '1 order blocks withdrawal: #3 (waiting for reveal, about 1m 20s)'
  )

  // 2 blockers
  const track2 = {
    now,
    orders: [
      { id: '3', state: 'committed', blocking: true },
      { id: '4', state: 'expired', blocking: true },
    ],
  }
  const blockers2 = {
    now,
    steps: [
      { id: '3', state: 'committed', action: 'wait', at: now + 80 },
      { id: '4', state: 'expired', action: 'expire', at: null },
    ],
  }
  assert.equal(
    withdrawalSummary(track2, blockers2),
    '2 orders block withdrawal: #3 (waiting for reveal, about 1m 20s), #4 (needs cleanup)'
  )
})

test('policyText with and without admission', () => {
  const policyWithAdmission = {
    depositToken: 'TKB',
    depositAmount: '5.0',
    commitFee: '0.000000000000000001',
    bountyBps: 2000,
    admissionRequired: true,
  }
  const text1 = policyText(policyWithAdmission)
  assert.match(text1, /Commit fee: 0.000000000000000001 TKB, always kept\./)
  assert.match(text1, /Deposit: 5\.0 TKB per order, returned when the order is revealed\./)
  assert.match(text1, /If a keeper reveals it, the keeper keeps 20% of the deposit\. Reveal it yourself to keep all of it\./)
  assert.match(text1, /If it's never revealed, release returns the deposit minus the fee\./)

  const policyWithoutAdmission = {
    depositToken: 'TKB',
    depositAmount: '5.0',
    commitFee: '0',
    bountyBps: 2000,
    admissionRequired: false,
  }
  const text2 = policyText(policyWithoutAdmission)
  assert.match(text2, /Commit fee: always kept\./)
  assert.match(text2, /If it's never revealed, it can be slashed and the deposit is lost\./)
})

test('orderRows returns full row objects from track and blockers JSON fixtures', () => {
  const track = {
    now: 1700000000,
    orders: [
      {
        id: '0',
        batch: '1',
        state: 'filled',
        fill: 'partial',
        side: 'sell',
        amountIn: '10.0',
        tokenIn: 'TKA',
        minOut: '9.0',
        tokenOut: 'TKB',
        executedIn: '6.0',
        received: '5.9',
        unusedIn: '4.0',
        schedule: { revealOpens: 1700000100, revealCloses: 1700000124, settleCloses: 1700000154 },
        blocking: false,
        commitTx: '0x123',
      },
    ],
  }
  const rows = orderRows(track, { now: 1700000000, steps: [] })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, '0')
  assert.equal(rows[0].batch, '1')
  assert.equal(rows[0].title, 'Sell 10.0 TKA for at least 9.0 TKB')
  assert.equal(rows[0].stage, 'Partly filled')
  assert.deepEqual(rows[0].amounts, { amountIn: '10.0', executedIn: '6.0', received: '5.9', unusedIn: '4.0' })
  assert.equal(rows[0].blocking, false)
  assert.equal(rows[0].next, null)
})
