// Pure logic behind the CLI: balance views, commit preflight, deadlines and commitment tracking.

/** Vault balances as the user sees them. Any open commitment blocks every withdrawal (BlindfoldVault.withdraw). */
export function balances({ balance, locked, open }) {
  const available = balance - locked
  return { available, reserved: locked, withdrawable: open === 0n ? available : 0n }
}

/**
 * What a commit needs, checked before encrypting or paying gas.
 * The deposit and fee leave the vault at commit; the order's input is locked only at reveal, so it must still be
 * free then. Shortfalls are covered from the wallet, which may need an approval first.
 */
export function preflight({ order, tokenIn, depositToken, depositAmount, fee, free, wallet, allowance, batch, minLead = 3n }) {
  const problems = []
  const need = { [depositToken]: depositAmount + fee }
  if (order.amountIn > 0n) need[tokenIn] = (need[tokenIn] ?? 0n) + order.amountIn
  const funding = Object.entries(need).map(([token, amount]) => {
    const shortfall = amount > free[token] ? amount - free[token] : 0n
    const approve = shortfall > allowance[token] ? shortfall : 0n
    if (shortfall > wallet[token]) problems.push(`not enough ${token}: need ${amount}, vault free ${free[token]}, wallet ${wallet[token]}`)
    return { token, need: amount, free: free[token], shortfall, approve }
  })
  if (order.amountIn > 0n && order.minAmountOut === 0n) problems.push('minAmountOut is 0: the order has no price protection')
  if (batch.id !== batch.current) problems.push(`batch ${batch.id} is not open (current ${batch.current})`)
  else if (batch.commits >= batch.maxCommits) problems.push(`batch ${batch.id} is full (${batch.maxCommits} commitments)`)
  else if (batch.commitsClose - batch.now < minLead) problems.push(`batch ${batch.id} closes in ${batch.commitsClose - batch.now}s; wait for the next one`)
  return { ok: problems.length === 0, problems, funding }
}

/** Schedule of one batch, with what each deadline means for the user. */
export function deadlines(v) {
  return [
    { at: v.commitsClose, what: 'commits close' },
    { at: v.revealOpens, what: 'drand round out: anyone can reveal' },
    { at: v.revealCloses, what: 'reveal window ends: an unrevealed commitment can be slashed (deposit lost)' },
    { at: v.settleCloses, what: 'settle window ends: anyone can expire the batch, unlocking unsettled input' },
  ]
}

/**
 * Status of each of an account's commitments from settlement events (viem parseEventLogs output, in order).
 * Returns Map(commitId → {id, batchId, state, ...}); state is one of
 * committed | revealed | padding | unfunded | slashed | filled | unfilled | expired.
 */
export function track(logs, owner) {
  const mine = new Map()
  const expired = new Set()
  const lower = owner.toLowerCase()
  for (const { eventName: e, args: a } of logs) {
    if (e === 'Committed' && a.committer.toLowerCase() === lower) mine.set(a.commitId, { id: a.commitId, batchId: a.batchId, state: 'committed', round: a.round, hash: a.hash })
    if (e === 'Expired') expired.add(a.batchId)
    const c = a?.commitId != null ? mine.get(a.commitId) : a?.id != null ? mine.get(a.id) : undefined
    if (!c) continue
    if (e === 'Revealed') Object.assign(c, { state: a.order.amountIn === 0n ? 'padding' : 'revealed', order: a.order })
    if (e === 'RevealedUnfunded') Object.assign(c, { state: 'unfunded', order: a.order })
    if (e === 'Slashed') c.state = 'slashed'
    if (e === 'Filled') Object.assign(c, { state: 'filled', amountIn: a.amountIn, amountOut: a.amountOut })
    if (e === 'Unfilled') c.state = 'unfilled'
  }
  for (const c of mine.values()) if (c.state === 'revealed' && expired.has(c.batchId)) c.state = 'expired'
  return mine
}

/** Commitments still holding the account's vault open: never revealed, or revealed and not yet settled/expired. */
export const isOpen = (c) => c.state === 'committed' || c.state === 'revealed'

/**
 * Why each open commitment blocks withdrawal, and the step that clears it now (REVIEW S4).
 * open: open commitments from track(); sched: Map(batchId → {revealOpens, revealCloses, settleCloses});
 * saved: Set of commitment hashes whose order and salt the client still has; now: latest block timestamp.
 * action: 'reveal' (own saved order), 'slash' (unrevealed after the window), 'expire' (unsettled after the deadline)
 * or 'wait' until `at`.
 */
export function exitPlan(open, { now, sched, saved }) {
  return open.map((c) => {
    const s = sched.get(c.batchId)
    if (c.state === 'committed') {
      if (now < s.revealOpens) return { c, action: 'wait', at: s.revealOpens, why: 'sealed until its drand round' }
      if (now < s.revealCloses) {
        return saved.has(c.hash)
          ? { c, action: 'reveal', why: 'own saved order: revealing it yourself keeps the bounty' }
          : { c, action: 'wait', at: s.revealCloses, why: 'order and salt not saved here: a keeper must reveal it, or it can be slashed' }
      }
      return { c, action: 'slash', why: 'never revealed: slashing forfeits its deposit and releases the account' }
    }
    if (now < s.settleCloses) return { c, action: 'wait', at: s.settleCloses, why: 'revealed, waiting for settlement; expirable after' }
    return { c, action: 'expire', why: 'nobody settled the batch: expiring unlocks its input' }
  })
}
