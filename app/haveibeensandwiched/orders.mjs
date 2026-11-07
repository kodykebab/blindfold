/**
 * Order view model for the trading page.
 * Pure module with no DOM dependencies.
 */

function parseLastJson(stdout, validator) {
  if (typeof stdout !== 'string') return { error: 'unreadable output' }
  const lines = stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return { error: 'unreadable output' }
  try {
    const parsed = JSON.parse(lines[lines.length - 1])
    if (!parsed || typeof parsed !== 'object' || (validator && !validator(parsed))) {
      return { error: 'unreadable output' }
    }
    return parsed
  } catch {
    return { error: 'unreadable output' }
  }
}

export function parseTrack(stdout) {
  return parseLastJson(stdout, (v) => Array.isArray(v.orders))
}

export function parseBlockers(stdout) {
  return parseLastJson(stdout, (v) => Array.isArray(v.steps))
}

export function parseCleanup(stdout) {
  return parseLastJson(stdout, (v) => Array.isArray(v.done))
}

export function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  const mins = String(Math.floor(s / 60)).padStart(2, '0')
  const secs = String(s % 60).padStart(2, '0')
  return `${mins}:${secs}`
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(total / 60)
  const secs = total % 60
  if (mins > 0 && secs > 0) return `${mins}m ${secs}s`
  if (mins > 0) return `${mins}m`
  return `${secs}s`
}

export function orderTitle(order) {
  if (order.side && order.amountIn && order.tokenIn && order.minOut && order.tokenOut) {
    const verb = order.side === 'sell' ? 'Sell' : 'Buy'
    return `${verb} ${order.amountIn} ${order.tokenIn} for at least ${order.minOut} ${order.tokenOut}`
  }
  return 'Sealed order'
}

export function stageLabel(order) {
  switch (order.state) {
    case 'committed': return 'Waiting for reveal'
    case 'revealed': return 'Waiting for settlement'
    case 'padding': return 'Padding'
    case 'unfunded': return 'Closed: unfunded'
    case 'filled': return order.fill === 'partial' ? 'Partly filled' : 'Filled'
    case 'unfilled': return 'Not filled'
    case 'slashed': return 'Slashed'
    case 'released': return 'Released'
    case 'expired': return 'Expired'
    default: return order.state ?? ''
  }
}

export function outcomeText(order) {
  const batch = order.batch ?? '?'
  switch (order.state) {
    case 'committed':
      return `Encrypted. A keeper or you reveal it once the drand round for batch ${batch} is out.`
    case 'revealed': {
      const deadline = order.settleClosesText ?? order.schedule?.settleClosesText
        ?? (typeof order.schedule?.settleCloses === 'string'
          ? order.schedule.settleCloses
          : (order.schedule?.settleCloses
            ? new Date(order.schedule.settleCloses * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : `{settleCloses}`))
      return `Revealed. The solver settles batch ${batch} before ${deadline}.`
    }
    case 'padding':
      return 'A zero-size order used to hide your order count. Nothing to trade.'
    case 'unfunded':
      return "The vault didn't hold the input at reveal, so the order was closed and its deposit kept."
    case 'filled':
      if (order.fill === 'partial') {
        return `Sold ${order.executedIn} of ${order.amountIn} ${order.tokenIn}, received ${order.received} ${order.tokenOut}. ${order.unusedIn} ${order.tokenIn} unused stays in your vault.`
      }
      return `Sold ${order.amountIn} ${order.tokenIn}, received ${order.received} ${order.tokenOut}.`
    case 'unfilled':
      return `The clearing price was outside your limit. All ${order.amountIn} ${order.tokenIn} stays in your vault.`
    case 'slashed':
      return 'Never revealed, so the deposit was forfeited.'
    case 'released':
      return 'Never revealed. The deposit was returned minus the fee.'
    case 'expired':
      return 'The batch was never settled. Your input stays in your vault; run cleanup.'
    default:
      return ''
  }
}

export function nextStep(order, step, now) {
  if (step) {
    if (step.action === 'reveal') {
      return {
        action: 'reveal',
        text: 'Reveal now (keeps your bounty)',
        button: 'Reveal now (keeps your bounty)',
        step,
      }
    }
    if (step.action === 'wait') {
      const remaining = step.at != null ? step.at - now : 0
      return {
        action: 'wait',
        text: `Wait ${formatCountdown(remaining)}`,
        button: null,
        at: step.at,
        step,
      }
    }
    if (['release', 'slash', 'expire'].includes(step.action)) {
      return {
        action: step.action,
        text: 'Clean up',
        button: 'Clean up',
        step,
      }
    }
  }
  if (order.blocking) {
    return {
      action: null,
      text: 'Waiting',
      button: null,
    }
  }
  return null
}

export function orderRows(track, blockers) {
  if (!track || !Array.isArray(track.orders)) return []
  const steps = Array.isArray(blockers?.steps) ? blockers.steps : []
  const now = Number(track.now ?? blockers?.now ?? Math.floor(Date.now() / 1000))

  return track.orders.map((order) => {
    const step = steps.find((s) => String(s.id) === String(order.id))
    return {
      id: String(order.id),
      batch: String(order.batch),
      title: orderTitle(order),
      stage: stageLabel(order),
      outcome: outcomeText(order),
      amounts: {
        amountIn: order.amountIn ?? null,
        executedIn: order.executedIn ?? null,
        received: order.received ?? null,
        unusedIn: order.unusedIn ?? null,
      },
      blocking: Boolean(order.blocking),
      next: nextStep(order, step, now),
      raw: order,
    }
  })
}

export function withdrawalSummary(track, blockers) {
  const orders = Array.isArray(track?.orders) ? track.orders : []
  const steps = Array.isArray(blockers?.steps) ? blockers.steps : []
  const now = Number(track?.now ?? blockers?.now ?? Math.floor(Date.now() / 1000))

  // Find all blocking orders
  const blockingOrders = orders.filter((o) => o.blocking)
  // If no track orders provided, check blockers steps directly
  const list = blockingOrders.length ? blockingOrders : steps.map((s) => ({ id: s.id, state: s.state, blocking: true }))

  if (!list.length) return 'Nothing blocks withdrawal'

  const items = list.map((order) => {
    const id = String(order.id)
    const step = steps.find((s) => String(s.id) === id)
    if (step?.action === 'wait') {
      const label = (order.state === 'revealed' || step.state === 'revealed') ? 'waiting for settlement' : 'waiting for reveal'
      const rem = step.at != null ? formatDuration(step.at - now) : ''
      return `#${id} (${label}${rem ? `, about ${rem}` : ''})`
    }
    return `#${id} (needs cleanup)`
  })

  const count = list.length
  return `${count} order${count === 1 ? '' : 's'} block${count === 1 ? 's' : ''} withdrawal: ${items.join(', ')}`
}

export function policyText(policy) {
  if (!policy) return ''
  const fee = policy.commitFee && policy.commitFee !== '0'
    ? `Commit fee: ${policy.commitFee} ${policy.depositToken}, always kept.`
    : 'Commit fee: always kept.'
  const deposit = `Deposit: ${policy.depositAmount} ${policy.depositToken} per order, returned when the order is revealed.`
  const bountyPercent = policy.bountyBps ? policy.bountyBps / 100 : 0
  const bounty = `If a keeper reveals it, the keeper keeps ${bountyPercent}% of the deposit. Reveal it yourself to keep all of it.`
  const unrevealed = policy.admissionRequired
    ? "If it's never revealed, release returns the deposit minus the fee."
    : "If it's never revealed, it can be slashed and the deposit is lost."
  return `${fee} ${deposit} ${bounty} ${unrevealed}`
}
