// Pure logic behind the CLI: balance views, commit preflight, deadlines and commitment tracking.
import { formatEther } from 'viem'

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
export function preflight({ order, tokenIn, depositToken, depositAmount, fee, free, wallet, allowance, batch, openBatches = [], minLead = 3n, cumulative = {} }) {
  const problems = []
  for (const n of [order.amountIn, order.minAmountOut]) if (n < 0n || n >= 1n << 128n) problems.push('order amounts must fit uint128')
  // One active batch per account (REVIEW S11, R10): a commit into a new batch while an older one is open takes another
  // deposit from the same free balance its order still needs, so that order can end up unfunded.
  const other = openBatches.filter((b) => b !== batch.id)
  if (other.length) problems.push(`open commitments in batch ${other.join(', ')}: one active batch per account; wait for it to finish or run cleanup`)
  const need = { ...cumulative }
  need[depositToken] = (need[depositToken] ?? 0n) + depositAmount + fee
  if (order.amountIn > 0n) need[tokenIn] = (need[tokenIn] ?? 0n) + order.amountIn
  const funding = Object.entries(need).map(([token, amount]) => {
    const shortfall = amount > free[token] ? amount - free[token] : 0n
    const approve = shortfall > allowance[token] ? shortfall : 0n
    if (shortfall > wallet[token]) problems.push(`not enough ${token}: need ${amount}, vault free ${free[token]}, wallet ${wallet[token]}`)
    return { token, need: amount, free: free[token], shortfall, approve }
  })
  if (order.amountIn > 0n && order.minAmountOut === 0n) problems.push('minAmountOut is 0: the order has no price protection')
  // Each funding transaction mines a block first, so the commit lands at now + txs + 1 or later, and the contract takes
  // it only before commitsClose (BatchAuction.currentBatch). The configured lead is a margin on top of that floor.
  const txs = BigInt(funding.reduce((n, f) => n + (f.shortfall ? 1 : 0) + (f.approve ? 1 : 0), 0))
  const lead = minLead > txs + 2n ? minLead : txs + 2n
  // The next batch is accepted too: the order is proved ahead and submitted as that batch opens.
  if (batch.id !== batch.current && batch.id !== batch.current + 1n) problems.push(`batch ${batch.id} is not open (current ${batch.current})`)
  else if (batch.commits >= batch.maxCommits) problems.push(`batch ${batch.id} is full (${batch.maxCommits} commitments)`)
  else if (batch.commitsClose - batch.now < lead) problems.push(`batch ${batch.id} closes in ${batch.commitsClose - batch.now}s; wait for the next one`)
  return { ok: problems.length === 0, problems, funding }
}

/** One planned transaction's gas: an estimate with its unit and cost, or why it is unavailable. Never shown as zero (T04). */
export function gasLine({ what, gas, gasPrice, why }) {
  if (gas == null) return `${what}: unavailable ${why ?? ''}`.trimEnd()
  return `${what}: ~${gas} gas ≈ ${formatEther(gas * gasPrice)} ETH`
}

/** Schedule of one batch, with what each deadline means for the user. */
export function deadlines(v, admissionRequired = false) {
  return [
    { at: v.commitsClose, what: 'commits close' },
    { at: v.revealOpens, what: 'drand round out: anyone can reveal' },
    { at: v.revealCloses, what: admissionRequired ? 'reveal window ends: unrevealed deposit can be released (fee retained)' : 'reveal window ends: an unrevealed commitment can be slashed (deposit lost)' },
    { at: v.settleCloses, what: 'settle window ends: anyone can expire the batch, unlocking unsettled input' },
  ]
}

/**
 * Status of each of an account's commitments from settlement events (viem parseEventLogs output, in order).
 * Returns Map(commitId → {id, batchId, state, ...}); state is one of
 * committed | revealed | padding | unfunded | slashed | released | filled | partial | unfilled | expired.
 * A fill or no-fill also carries its batch's clearing price (priceX96) and settlement transaction (settleTx); a reveal or
 * slash records who sent it (by), since that account received the bounty.
 */
export function track(logs, owner) {
  const mine = new Map()
  const expired = new Set()
  const settled = new Map()
  const lower = owner.toLowerCase()
  for (const { eventName: e, args: a, transactionHash } of logs) {
    if (e === 'Committed' && a.committer.toLowerCase() === lower) mine.set(a.commitId, { id: a.commitId, batchId: a.batchId, state: 'committed', round: a.round, hash: a.hash })
    if (e === 'Expired') expired.add(a.batchId)
    if (e === 'Settled') settled.set(a.batchId, a.priceX96)
    const c = a?.commitId != null ? mine.get(a.commitId) : a?.id != null ? mine.get(a.id) : undefined
    if (!c) continue
    if (e === 'Revealed') Object.assign(c, { state: a.order.amountIn === 0n ? 'padding' : 'revealed', order: a.order, by: a.revealer })
    if (e === 'RevealedUnfunded') Object.assign(c, { state: 'unfunded', order: a.order, by: a.revealer })
    if (e === 'Slashed') Object.assign(c, { state: 'slashed', by: a.caller })
    if (e === 'Released') c.state = 'released'
    // Filled carries the input actually spent: less than the order's input is a proportional (partial) fill.
    if (e === 'Filled') Object.assign(c, { state: c.order && a.amountIn < c.order.amountIn ? 'partial' : 'filled', amountIn: a.amountIn, amountOut: a.amountOut, settleTx: transactionHash })
    if (e === 'Unfilled') Object.assign(c, { state: 'unfilled', settleTx: transactionHash })
  }
  for (const c of mine.values()) {
    if (c.state === 'revealed' && expired.has(c.batchId)) c.state = 'expired'
    if (c.settleTx !== undefined && settled.has(c.batchId)) c.priceX96 = settled.get(c.batchId)
  }
  return mine
}

/** Render actual input and output without treating a partial execution as a full fill. */
export function fillDescription(commitment, format) {
  if (!['filled', 'partial'].includes(commitment.state) || !commitment.order) return ''
  const order = commitment.order
  const input = order.zeroForOne ? 'token0' : 'token1'
  const output = order.zeroForOne ? 'token1' : 'token0'
  const kind = commitment.amountIn < order.amountIn ? 'partial fill' : 'full fill'
  return ` → got ${format(output, commitment.amountOut)} [${kind}: ${format(input, commitment.amountIn)} of ${format(input, order.amountIn)}]`
}

/**
 * Where a commitment's deposit went (BatchAuction.reveal and slashUnrevealed), in deposit-token units (T11). The fee is
 * separate: charged at commit and never returned. A bounty the owner earned by revealing or slashing it themselves comes
 * back to them, so it is counted as returned. held: still escrowed; lost: sent to the treasury.
 */
export function depositOutcome(c, { depositAmount, bountyBps, owner }) {
  const bounty = (depositAmount * BigInt(bountyBps)) / 10_000n
  const paid = c.by?.toLowerCase() === owner.toLowerCase() ? 0n : bounty
  const none = { held: 0n, returned: 0n, bounty: 0n, lost: 0n }
  if (c.state === 'committed') return { ...none, held: depositAmount }
  if (c.state === 'released') return { ...none, returned: depositAmount }
  if (c.state === 'unfunded' || c.state === 'slashed') return { ...none, returned: bounty - paid, bounty: paid, lost: depositAmount - bounty }
  return { ...none, returned: depositAmount - paid, bounty: paid }
}

/** Commitments still holding the account's vault open: never revealed, or revealed and not yet settled/expired. */
export const isOpen = (c) => c.state === 'committed' || c.state === 'revealed'

/**
 * Why each open commitment blocks withdrawal, and the step that clears it now (REVIEW S4).
 * open: open commitments from track(); sched: Map(batchId → {revealOpens, revealCloses, settleCloses});
 * saved: Set of commitment hashes whose order and salt the client still has; now: latest block timestamp.
 * action: 'reveal' (own saved order), 'slash' (unrevealed after the window), 'expire' (unsettled after the deadline)
 * or 'wait' until `at`.
 * Each step is simulated at `now` and lands in a later block, so it is offered only when the contract accepts it at
 * both now and now + 1 (BatchAuction.reveal: opens <= t < closes; slashUnrevealed: t >= closes; expire: t >= settleCloses).
 * In the last second of the reveal window a reveal would land after it, so the plan waits for the slash or release.
 */
export function exitPlan(open, { now, sched, saved, admissionRequired = false }) {
  return open.map((c) => {
    const s = sched.get(c.batchId)
    if (c.state === 'committed') {
      if (now < s.revealOpens) return { c, action: 'wait', at: s.revealOpens, why: 'sealed until its drand round' }
      if (now + 1n < s.revealCloses) {
        return saved.has(c.hash)
          ? { c, action: 'reveal', why: 'own saved order: revealing it yourself keeps the bounty' }
          : { c, action: 'wait', at: s.revealCloses, why: admissionRequired ? 'order and salt not saved here: a keeper can reveal it; otherwise the deposit can be released after the window' : 'order and salt not saved here: a keeper must reveal it, or it can be slashed' }
      }
      if (now < s.revealCloses) return { c, action: 'wait', at: s.revealCloses, why: `reveal window closes in 1s, too soon for a reveal to land; it can be ${admissionRequired ? 'released' : 'slashed'} after` }
      if (admissionRequired) return { c, action: 'release', why: 'never revealed: release returns the deposit, retains the fee and closes the commitment' }
      return { c, action: 'slash', why: 'never revealed: slashing forfeits its deposit and releases the account' }
    }
    if (now < s.settleCloses) return { c, action: 'wait', at: s.settleCloses, why: 'revealed, waiting for settlement; expirable after' }
    return { c, action: 'expire', why: 'nobody settled the batch: expiring unlocks its input' }
  })
}
