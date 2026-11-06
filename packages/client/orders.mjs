import { formatUnits } from 'viem'
import { isOpen } from './flow.mjs'

/**
 * Pure JSON view of a single commitment for track --json.
 * @param {object} c - commitment from track()
 * @param {object} options - { policy, tokens, saved, schedule }
 */
export function orderView(c, { policy, tokens, saved, schedule } = {}) {
  const isMap = saved instanceof Map
  const localSaved = isMap ? saved.get(c.hash) : (Array.isArray(saved) ? saved.find((x) => x.hash === c.hash) : null)
  let order = c.order ?? null
  let sealedLocally = false
  if (!order && localSaved?.order) {
    order = localSaved.order
    if (c.state === 'committed') sealedLocally = true
  }

  let side = null
  let tokenIn = null
  let tokenOut = null
  let amountIn = null
  let minOut = null
  let executedIn = null
  let received = null
  let unusedIn = null
  let fill = null

  if (order && tokens) {
    const isSell = Boolean(order.zeroForOne)
    side = isSell ? 'sell' : 'buy'
    const tIn = isSell ? tokens.token0 : tokens.token1
    const tOut = isSell ? tokens.token1 : tokens.token0
    tokenIn = tIn.symbol
    tokenOut = tOut.symbol
    amountIn = formatUnits(order.amountIn, tIn.decimals)
    minOut = formatUnits(order.minAmountOut, tOut.decimals)

    if (c.state === 'filled') {
      if (c.amountIn != null) executedIn = formatUnits(c.amountIn, tIn.decimals)
      if (c.amountOut != null) received = formatUnits(c.amountOut, tOut.decimals)
      if (c.amountIn != null) {
        const unused = order.amountIn > c.amountIn ? order.amountIn - c.amountIn : 0n
        unusedIn = formatUnits(unused, tIn.decimals)
        fill = c.amountIn < order.amountIn ? 'partial' : 'full'
      }
    } else if (['unfilled', 'expired', 'released'].includes(c.state)) {
      unusedIn = formatUnits(order.amountIn, tIn.decimals)
    }
  }

  const scheduleObj = schedule ? {
    revealOpens: Number(schedule.revealOpens),
    revealCloses: Number(schedule.revealCloses),
    settleCloses: Number(schedule.settleCloses),
  } : null

  const commitTx = c.tx ?? localSaved?.tx ?? null

  const row = {
    id: c.id != null ? String(c.id) : null,
    batch: c.batchId != null ? String(c.batchId) : null,
    state: c.state,
    side,
    amountIn,
    tokenIn,
    minOut,
    tokenOut,
    executedIn,
    received,
    unusedIn,
    fill,
    schedule: scheduleObj,
    blocking: isOpen(c),
    commitTx,
  }
  if (sealedLocally) row.sealedLocally = true
  return row
}

/**
 * Shape trackAll --json output.
 */
export function ordersPayload({ policy, now, commitments, tokens, saved, schedules } = {}) {
  const orders = (commitments ?? []).map((c) => {
    const sched = schedules instanceof Map ? schedules.get(c.batchId) : schedules?.[c.batchId]
    return orderView(c, { policy, tokens, saved, schedule: sched })
  })
  return {
    policy,
    now: Number(now),
    orders,
  }
}

/**
 * Shape blockers --json output.
 */
export function blockersPayload({ now, steps } = {}) {
  return {
    now: Number(now),
    steps: (steps ?? []).map((s) => ({
      id: s.c?.id != null ? String(s.c.id) : String(s.id),
      batch: s.c?.batchId != null ? String(s.c.batchId) : String(s.batch),
      state: s.c?.state ?? s.state,
      action: s.action,
      at: s.at != null ? Number(s.at) : null,
      why: s.why,
    })),
  }
}

/**
 * Shape cleanup --json output.
 */
export function cleanupPayload({ dryRun, done, stillBlocking } = {}) {
  return {
    dryRun: Boolean(dryRun),
    done: (done ?? []).map((d) => ({
      id: String(d.id),
      action: d.action,
      tx: d.tx ?? null,
    })),
    stillBlocking: Number(stillBlocking ?? 0),
  }
}
