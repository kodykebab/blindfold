import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orderView, ordersPayload, blockersPayload, cleanupPayload } from '../orders.mjs'

const tokens = {
  token0: { address: '0x1000', symbol: 'TKA', decimals: 18 },
  token1: { address: '0x2000', symbol: 'TKB', decimals: 18 },
  depositToken: '0x2000',
  byAddress: {
    '0x1000': { address: '0x1000', symbol: 'TKA', decimals: 18 },
    '0x2000': { address: '0x2000', symbol: 'TKB', decimals: 18 },
  },
}

const policy = {
  depositToken: 'TKB',
  depositAmount: '5.0',
  commitFee: '0.000000000000000001',
  bountyBps: 2000,
  admissionRequired: true,
}

const schedule = {
  revealOpens: 1700000100n,
  revealCloses: 1700000124n,
  settleCloses: 1700000154n,
}

test('orderView: sealed commitment without local state', () => {
  const c = { id: 0n, batchId: 1n, state: 'committed', hash: '0xhash0' }
  const view = orderView(c, { policy, tokens, saved: new Map(), schedule })

  assert.equal(view.id, '0')
  assert.equal(typeof view.id, 'string')
  assert.equal(view.batch, '1')
  assert.equal(typeof view.batch, 'string')
  assert.equal(view.state, 'committed')
  assert.equal(view.side, null)
  assert.equal(view.amountIn, null)
  assert.equal(view.tokenIn, null)
  assert.equal(view.minOut, null)
  assert.equal(view.tokenOut, null)
  assert.equal(view.executedIn, null)
  assert.equal(view.received, null)
  assert.equal(view.unusedIn, null)
  assert.equal(view.fill, null)
  assert.equal(view.blocking, true)
  assert.equal(view.sealedLocally, undefined)
  assert.deepEqual(view.schedule, {
    revealOpens: 1700000100,
    revealCloses: 1700000124,
    settleCloses: 1700000154,
  })
})

test('orderView: sealed commitment with local state', () => {
  const c = { id: 0n, batchId: 1n, state: 'committed', hash: '0xhash0', tx: '0xtx0' }
  const savedOrder = { owner: '0xme', zeroForOne: true, amountIn: 10n * 10n ** 18n, minAmountOut: 9n * 10n ** 18n }
  const saved = new Map([['0xhash0', { order: savedOrder, tx: '0xtx0' }]])
  const view = orderView(c, { policy, tokens, saved, schedule })

  assert.equal(view.id, '0')
  assert.equal(view.side, 'sell')
  assert.equal(view.amountIn, '10')
  assert.equal(view.tokenIn, 'TKA')
  assert.equal(view.minOut, '9')
  assert.equal(view.tokenOut, 'TKB')
  assert.equal(view.sealedLocally, true)
  assert.equal(view.blocking, true)
  assert.equal(view.commitTx, '0xtx0')
})

test('orderView: revealed order waiting for settlement', () => {
  const order = { owner: '0xme', zeroForOne: false, amountIn: 5n * 10n ** 18n, minAmountOut: 4n * 10n ** 18n }
  const c = { id: 1n, batchId: 1n, state: 'revealed', hash: '0xhash1', order }
  const view = orderView(c, { policy, tokens, saved: new Map(), schedule })

  assert.equal(view.id, '1')
  assert.equal(view.state, 'revealed')
  assert.equal(view.side, 'buy')
  assert.equal(view.amountIn, '5')
  assert.equal(view.tokenIn, 'TKB')
  assert.equal(view.minOut, '4')
  assert.equal(view.tokenOut, 'TKA')
  assert.equal(view.executedIn, null)
  assert.equal(view.received, null)
  assert.equal(view.unusedIn, null)
  assert.equal(view.fill, null)
  assert.equal(view.blocking, true)
})

test('orderView: padding order', () => {
  const order = { owner: '0xme', zeroForOne: true, amountIn: 0n, minAmountOut: 0n }
  const c = { id: 2n, batchId: 1n, state: 'padding', hash: '0xhash2', order }
  const view = orderView(c, { policy, tokens, saved: new Map(), schedule })

  assert.equal(view.state, 'padding')
  assert.equal(view.amountIn, '0')
  assert.equal(view.minOut, '0')
  assert.equal(view.fill, null)
  assert.equal(view.blocking, false)
})

test('orderView: unfunded order', () => {
  const order = { owner: '0xme', zeroForOne: true, amountIn: 10n * 10n ** 18n, minAmountOut: 9n * 10n ** 18n }
  const c = { id: 3n, batchId: 1n, state: 'unfunded', hash: '0xhash3', order }
  const view = orderView(c, { policy, tokens, saved: new Map(), schedule })

  assert.equal(view.state, 'unfunded')
  assert.equal(view.executedIn, null)
  assert.equal(view.fill, null)
  assert.equal(view.blocking, false)
})

test('orderView: full fill', () => {
  const order = { owner: '0xme', zeroForOne: true, amountIn: 10n * 10n ** 18n, minAmountOut: 9n * 10n ** 18n }
  const c = {
    id: 4n,
    batchId: 1n,
    state: 'filled',
    hash: '0xhash4',
    order,
    amountIn: 10n * 10n ** 18n,
    amountOut: 98n * 10n ** 17n, // 9.8
  }
  const view = orderView(c, { policy, tokens, saved: new Map(), schedule })

  assert.equal(view.state, 'filled')
  assert.equal(view.amountIn, '10')
  assert.equal(view.executedIn, '10')
  assert.equal(view.received, '9.8')
  assert.equal(view.unusedIn, '0')
  assert.equal(view.fill, 'full')
  assert.equal(view.blocking, false)
})

test('orderView: partial fill with unused input', () => {
  const order = { owner: '0xme', zeroForOne: true, amountIn: 10n * 10n ** 18n, minAmountOut: 9n * 10n ** 18n }
  const c = {
    id: 5n,
    batchId: 1n,
    state: 'filled',
    hash: '0xhash5',
    order,
    amountIn: 6n * 10n ** 18n,
    amountOut: 59n * 10n ** 17n, // 5.9
  }
  const view = orderView(c, { policy, tokens, saved: new Map(), schedule })

  assert.equal(view.state, 'filled')
  assert.equal(view.amountIn, '10')
  assert.equal(view.executedIn, '6')
  assert.equal(view.received, '5.9')
  assert.equal(view.unusedIn, '4')
  assert.equal(view.fill, 'partial')
  assert.equal(view.blocking, false)
})

test('orderView: unfilled order keeps all input unused', () => {
  const order = { owner: '0xme', zeroForOne: true, amountIn: 10n * 10n ** 18n, minAmountOut: 9n * 10n ** 18n }
  const c = { id: 6n, batchId: 1n, state: 'unfilled', hash: '0xhash6', order }
  const view = orderView(c, { policy, tokens, saved: new Map(), schedule })

  assert.equal(view.state, 'unfilled')
  assert.equal(view.amountIn, '10')
  assert.equal(view.executedIn, null)
  assert.equal(view.received, null)
  assert.equal(view.unusedIn, '10')
  assert.equal(view.fill, null)
  assert.equal(view.blocking, false)
})

test('orderView: slashed order', () => {
  const c = { id: 7n, batchId: 1n, state: 'slashed', hash: '0xhash7' }
  const view = orderView(c, { policy, tokens, saved: new Map(), schedule })

  assert.equal(view.state, 'slashed')
  assert.equal(view.blocking, false)
  assert.equal(view.fill, null)
})

test('orderView: released order keeps unused input if known', () => {
  const order = { owner: '0xme', zeroForOne: true, amountIn: 10n * 10n ** 18n, minAmountOut: 9n * 10n ** 18n }
  const c = { id: 8n, batchId: 1n, state: 'released', hash: '0xhash8' }
  const saved = new Map([['0xhash8', { order }]])
  const view = orderView(c, { policy, tokens, saved, schedule })

  assert.equal(view.state, 'released')
  assert.equal(view.unusedIn, '10')
  assert.equal(view.blocking, false)
})

test('orderView: expired order keeps unused input', () => {
  const order = { owner: '0xme', zeroForOne: true, amountIn: 10n * 10n ** 18n, minAmountOut: 9n * 10n ** 18n }
  const c = { id: 9n, batchId: 1n, state: 'expired', hash: '0xhash9', order }
  const view = orderView(c, { policy, tokens, saved: new Map(), schedule })

  assert.equal(view.state, 'expired')
  assert.equal(view.unusedIn, '10')
  assert.equal(view.blocking, false)
})

test('ordersPayload: formats policy and list of orders with numeric now', () => {
  const c = { id: 0n, batchId: 1n, state: 'committed', hash: '0x0' }
  const payload = ordersPayload({
    policy,
    now: 1700000000,
    commitments: [c],
    tokens,
    saved: new Map(),
    schedules: new Map([[1n, schedule]]),
  })

  assert.equal(payload.now, 1700000000)
  assert.equal(typeof payload.now, 'number')
  assert.deepEqual(payload.policy, policy)
  assert.equal(payload.orders.length, 1)
  assert.equal(payload.orders[0].id, '0')
})

test('blockersPayload: shapes steps with strings and numbers', () => {
  const steps = [
    { c: { id: 3n, batchId: 1n, state: 'committed' }, action: 'wait', at: 1700000100n, why: 'sealed until its drand round' },
    { c: { id: 4n, batchId: 1n, state: 'released' }, action: 'release', at: null, why: 'never revealed' },
  ]
  const payload = blockersPayload({ now: 1700000000, steps })

  assert.equal(payload.now, 1700000000)
  assert.deepEqual(payload.steps, [
    { id: '3', batch: '1', state: 'committed', action: 'wait', at: 1700000100, why: 'sealed until its drand round' },
    { id: '4', batch: '1', state: 'released', action: 'release', at: null, why: 'never revealed' },
  ])
})

test('cleanupPayload: formats dry run and completed actions', () => {
  const dry = cleanupPayload({ dryRun: true, done: [{ id: '3', action: 'reveal' }], stillBlocking: 1n })
  assert.deepEqual(dry, {
    dryRun: true,
    done: [{ id: '3', action: 'reveal', tx: null }],
    stillBlocking: 1,
  })

  const live = cleanupPayload({ dryRun: false, done: [{ id: '3', action: 'reveal', tx: '0xtx' }], stillBlocking: 0 })
  assert.deepEqual(live, {
    dryRun: false,
    done: [{ id: '3', action: 'reveal', tx: '0xtx' }],
    stillBlocking: 0,
  })
})
