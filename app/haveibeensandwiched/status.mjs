// Parse the client status report for display. The unmodified CLI output remains available in the activity log.
export function parseStatus(text) {
  const lines = text.split(/\r?\n/)
  const account = lines.find((line) => /^account 0x[0-9a-f]{40}$/i.test(line))?.slice(8)
  const batch = lines.find((line) => /^batch \d+ \(chain time \d+\)$/.test(line))
  const open = lines.find((line) => /^\s*open commitments: \d+/.test(line))?.trim()
  const rows = []
  for (const line of lines) {
    const match = line.match(/^\s*(\S+)\s+wallet\s+(.+?)\s+\|\s+available\s+(.+?)\s+\|\s+reserved\s+(.+?)\s+\|\s+withdrawable\s+(.+?)\s*$/)
    if (match) rows.push({ token: match[1], wallet: match[2], available: match[3], reserved: match[4], withdrawable: match[5] })
  }
  if (!account || !batch || !open || !rows.length) return null
  const deadlines = lines.filter((line) => /^\s*-?\d+s\s+/.test(line)).map((line) => line.trim())
  const network = lines.find((line) => /^network \d+$/.test(line)) ?? null
  const pair = lines.find((line) => /^pair .+ \/ .+$/.test(line)) ?? null
  const preparation = lines.find((line) => /^preparation: /.test(line)) ?? null
  return { account, network, pair, batch, open, rows, deadlines, preparation, tokens: tokenMeta(lines) }
}

const ADDRESS = /^0x[0-9a-f]{40}$/i

/** Shorten an address when the client could not read a symbol. Symbols pass through unchanged. */
export function shortToken(value) {
  return ADDRESS.test(value ?? '') ? `${value.slice(0, 6)}…${value.slice(-4)}` : value
}

/**
 * Pair label from `status`. Prefers token symbols. If a side is an address, show a short address.
 * Optional `token0 <symbol> <decimals> <address>` lines fill decimals when the client prints them.
 */
export function displayPair(parsed) {
  const fromLine = parsed?.pair?.match(/^pair\s+(\S+)\s+\/\s+(\S+)$/)
  const sides = fromLine ? [fromLine[1], fromLine[2]] : (parsed?.rows ?? []).map((row) => row.token).slice(0, 2)
  if (sides.length < 2) return { label: 'Pair not reported', symbols: [], source: 'missing' }
  const symbols = sides.map(shortToken)
  return { label: `${symbols[0]} / ${symbols[1]}`, symbols, source: sides.some((side) => ADDRESS.test(side)) ? 'address' : 'symbol' }
}

function tokenMeta(lines) {
  const tokens = []
  for (const line of lines) {
    const match = line.trim().match(/^(token[01])\s+(\S+)\s+(\d+)\s+(0x[0-9a-f]{40})$/i)
    if (match) tokens.push({ role: match[1].toLowerCase(), symbol: match[2], decimals: Number(match[3]), address: match[4] })
  }
  return tokens
}

// Only report stages the CLI has explicitly logged; elapsed time is not proof progress.
export function jobStage(job) {
  if (job.action === 'prepare-admission' && /preparing locally for batch/i.test(job.output)) return 'PREPARING'
  if (job.action === 'commit' && /local proving completed/i.test(job.output)) return 'FINALIZING'
  if (job.action === 'commit' && /generating (?:the online|both) admission proofs? locally/i.test(job.output)) return 'PROVING'
  return 'RUNNING'
}

export function preparedBatch(output) {
  return output.match(/(?:^|\n)prepared batch (\d+) in /)?.[1] ?? null
}

// Unknown or incomplete output remains in the activity log instead of being guessed.
export function parseTrack(text) {
  if (text.trim() === 'no commitments') return []
  const lines = text.trim().split(/\r?\n/)
  const rows = []
  for (const line of lines) {
    const match = line.match(/^#(\d+) batch (\d+): (committed|revealed|padding|unfunded|slashed|released|filled|unfilled|expired) \(([^)]*)\)(.*)$/)
    if (!match) return null
    const detail = match[5].trim()
    const label = match[3] === 'filled' && detail.includes('[partial fill:') ? 'partially filled' : match[3]
    const fill = fillParts(detail)
    const row = { id: match[1], batch: match[2], state: label, detail: [match[4], detail].filter(Boolean).join(' ') }
    if (fill) row.fill = fill
    row.summary = orderSummary(row)
    rows.push(row)
  }
  return rows.length ? rows : null
}

export const UINT128_MAX = (1n << 128n) - 1n
export const QUOTE_STALE_SECONDS = 15

const BALANCE_LABELS = [
  ['wallet', 'Wallet'],
  ['available', 'Available (vault)'],
  ['reserved', 'Reserved (open commitments)'],
  ['withdrawable', 'Withdrawable'],
]

/** Labels for the four balances the client already reports. */
export function balanceFields(row) {
  return BALANCE_LABELS.map(([key, label]) => ({ key, label, value: row[key] }))
}

/** What to print beside an amount box. Decimals come from optional status meta; the uint128 cap is the auction's. */
export function amountLimits(decimals) {
  if (decimals == null) {
    return 'Token decimals are not in the client status yet. Enter a plain decimal. More than 18 fractional digits are rejected and are not rounded. The smallest non-zero amount is 1 base unit. The auction cap is uint128 (2^128 − 1) base units; it is checked once decimals are reported.'
  }
  return `This token uses ${decimals} decimal places. The smallest non-zero amount is 1 base unit. The largest amount is uint128 (2^128 − 1) base units. Extra digits are rejected and are not rounded.`
}

/** Reject over-precise, zero, non-decimal and over-cap amounts. Never round. */
export function validateAmount(text, { decimals = null, allowAll = false } = {}) {
  const raw = String(text ?? '').trim()
  if (allowAll && raw === 'all') return { ok: true, value: raw }
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) {
    return { ok: false, message: 'Enter a plain decimal amount. This page does not round or accept scientific notation.' }
  }
  const [whole, frac = ''] = raw.split('.')
  const places = decimals == null ? 18 : decimals
  if (frac.length > places) {
    return {
      ok: false,
      message: decimals == null
        ? 'More than 18 decimal places was entered. This page will not round it. Token decimals are not in the status report yet.'
        : `This token has ${decimals} decimal places. Extra digits are rejected and are not rounded.`,
    }
  }
  if (/^0(?:\.0*)?$/.test(raw)) return { ok: false, message: 'The smallest non-zero amount is 1 base unit. Zero is rejected.' }
  if (decimals == null) return { ok: true, value: raw, capChecked: false }
  const base = BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(frac.padEnd(decimals, '0'))
  if (base > UINT128_MAX) return { ok: false, message: 'This amount is above the uint128 cap the auction accepts. It was not rounded.' }
  return { ok: true, value: raw, capChecked: true }
}

/** Public pool price, or the external reference when the client prints one. Age is in seconds at `now`. */
export function parseQuote(text, now = Date.now()) {
  let pool = null
  let external = null
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^quote (pool|external) (\S+) age (\d+)s$/)
    if (!match) continue
    const row = { source: match[1], price: match[2], ageSeconds: Number(match[3]), parsedAt: now }
    if (match[1] === 'external') external = row
    else pool = row
  }
  const chosen = external ?? pool
  if (!chosen) return null
  return stampQuote(chosen, now)
}

export function stampQuote(quote, now = Date.now()) {
  if (!quote) return null
  const ageSeconds = quote.ageSeconds + Math.max(0, Math.floor((now - quote.parsedAt) / 1000))
  return {
    ...quote,
    ageSeconds,
    stale: ageSeconds > QUOTE_STALE_SECONDS,
    label: quote.source === 'external' ? 'External reference' : 'Public v4 pool price',
  }
}

/** Pool liquidity and an execution estimate, only when the client printed them. */
export function parseLiquidity(text) {
  const line = String(text).split(/\r?\n/).map((item) => item.trim()).find((item) => item.startsWith('liquidity '))
  if (!line) return null
  const match = line.match(/^liquidity (\S+)(?: estimate (\S+ \S+))?$/)
  if (!match) return null
  return { liquidity: match[1], estimate: match[2] ?? null }
}

export function liquidityNote(info) {
  if (!info) return 'Pool liquidity near your limit is not reported by the client. Estimated execution is unavailable. An execution figure would be an estimate, not guaranteed.'
  const estimate = info.estimate ? `Estimated execution: ${info.estimate}.` : 'Estimated execution is not reported.'
  return `Pool liquidity near your limit: ${info.liquidity}. ${estimate} Estimate, not guaranteed.`
}

/** Structured review of a `commit --dry-run` transcript. Missing quote, gas or liquidity stay missing. */
const DECIMAL_TOKEN = '(\\d+(?:\\.\\d+)?) (\\S+)'

export function parsePreflight(text, now = Date.now()) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const order = lines.map((line) => line.match(new RegExp(`^order: (sell|buy) ${DECIMAL_TOKEN} for at least ${DECIMAL_TOKEN} in batch (\\d+)$`))).find(Boolean)
  if (!order) return null
  const costs = lines.map((line) => line.match(new RegExp(`^costs: deposit ${DECIMAL_TOKEN} \\((.+)\\), fee ${DECIMAL_TOKEN}$`))).find(Boolean)
  const funding = []
  for (const line of lines) {
    const match = line.match(new RegExp(`^funding (\\S+): need ${DECIMAL_TOKEN}, vault free ${DECIMAL_TOKEN}(?:, deposit ${DECIMAL_TOKEN} first( \\(needs approval\\))?)?$`))
    if (!match) continue
    funding.push({
      symbol: match[1],
      need: `${match[2]} ${match[3]}`,
      free: `${match[4]} ${match[5]}`,
      shortfall: match[6] ? `${match[6]} ${match[7]}` : null,
      approval: Boolean(match[8]),
    })
  }
  const deadlines = lines.filter((line) => /^-?\d+s\s+/.test(line))
  const gas = lines.map((line) => line.match(/^gas estimate (\d+)$/)).find(Boolean)
  const problems = []
  const failed = String(text).match(/preflight failed:\n([\s\S]*)$/)
  if (failed) {
    for (const line of failed[1].split(/\r?\n/)) {
      const item = line.replace(/^client: /, '').trim()
      if (item && !item.startsWith('preflight failed')) problems.push(item)
    }
  }
  const oneBatch = oneBatchReason(text)
  const quote = parseQuote(text, now)
  const liquidity = parseLiquidity(text)
  const shortfalls = funding.filter((row) => row.shortfall)
  return {
    side: order[1],
    amount: `${order[2]} ${order[3]}`,
    minimum: `${order[4]} ${order[5]}`,
    batch: order[6],
    deposit: costs ? `${costs[1]} ${costs[2]}` : null,
    depositReturn: costs?.[3] ?? null,
    fee: costs ? `${costs[4]} ${costs[5]}` : null,
    funding,
    shortfalls,
    deadlines,
    gas: gas ? gas[1] : null,
    problems,
    oneBatch,
    quote,
    liquidity,
    ok: problems.length === 0 && !oneBatch && shortfalls.length === 0 && !/fund both tokens/.test(text),
  }
}

export function oneBatchReason(text) {
  const match = String(text).match(/open commitments in batch ([^:]+): one active batch per account/)
  if (!match) return null
  return `One batch at a time per account. This account still has an open commitment in batch ${match[1]}. A new order waits until that batch settles or the commitment is released.`
}

export function fundFirst(review) {
  if (!review) return null
  if (/fund both tokens/.test(review.problems.join('\n'))) {
    return 'Fund first: both tokens need a non-zero balance in the vault before this page will submit an order.'
  }
  if (!review.shortfalls.length) return null
  const amounts = review.shortfalls.map((row) => row.shortfall).join('; ')
  return `Fund first: deposit ${amounts} into the vault. This page will not deposit that shortfall for you.`
}

/** Compare two preflight reviews. A stale quote or a changed balance needs a new confirm. */
export function reviewChanges(before, after) {
  if (!before || !after) return ['The review is incomplete. Preview the order again.']
  const changes = []
  if (before.side !== after.side || before.amount !== after.amount || before.minimum !== after.minimum || before.batch !== after.batch) {
    changes.push(`The order changed from ${before.side} ${before.amount} for at least ${before.minimum} in batch ${before.batch} to ${after.side} ${after.amount} for at least ${after.minimum} in batch ${after.batch}.`)
  }
  const prior = new Map(before.funding.map((row) => [row.symbol, row.free]))
  for (const row of after.funding) {
    if (prior.get(row.symbol) !== row.free) changes.push(`Available ${row.symbol} changed from ${prior.get(row.symbol) ?? 'unreported'} to ${row.free}.`)
  }
  const left = before.quote
  const right = after.quote
  if (left?.price !== right?.price || left?.source !== right?.source) {
    changes.push(`The reference price changed from ${left ? `${left.price} (${left.label})` : 'unreported'} to ${right ? `${right.price} (${right.label})` : 'unreported'}.`)
  }
  if (right?.stale) changes.push(`The reference price is stale (${right.ageSeconds}s old, older than ${QUOTE_STALE_SECONDS}s).`)
  if (after.oneBatch && after.oneBatch !== before.oneBatch) changes.push(after.oneBatch)
  return changes
}

export function batchPhase(deadlines) {
  const rows = (deadlines ?? []).map((line) => {
    const match = String(line).trim().match(/^(-?\d+)s\s+(.+)$/)
    return match ? { seconds: Number(match[1]), what: match[2] } : null
  }).filter(Boolean)
  const find = (part) => rows.find((row) => row.what.includes(part))
  const commits = find('commits close')
  let phase = 'unknown'
  if (commits) {
    const reveal = find('drand')
    const revealEnd = find('reveal window')
    const settle = find('settle window')
    if (commits.seconds > 0) phase = 'committing'
    else if (reveal && reveal.seconds > 0) phase = 'waiting for the drand round'
    else if (revealEnd && revealEnd.seconds > 0) phase = 'reveal window'
    else if (settle && settle.seconds > 0) phase = 'settlement window'
    else phase = 'settle window closed'
  }
  return { phase, deadlines: rows }
}

export function mempoolView(rows) {
  if (!rows) return null
  const committed = rows.filter((row) => row.state === 'committed').length
  return { committed, note: 'Committed and not yet revealed. This is a count only. Order contents stay sealed.' }
}

function splitAmount(text) {
  const match = String(text).trim().match(/^(\d+(?:\.\d+)?) (\S+)$/)
  return match ? { amount: match[1], symbol: match[2] } : null
}

function subtractDecimal(total, executed) {
  const scale = 10n ** 18n
  const toBase = (value) => {
    const [whole, frac = ''] = value.split('.')
    return BigInt(whole) * scale + BigInt(frac.padEnd(18, '0').slice(0, 18))
  }
  let base = toBase(total) - toBase(executed)
  if (base < 0n) base = 0n
  const whole = base / scale
  const frac = base % scale
  const digits = frac.toString().padStart(18, '0').replace(/0+$/, '')
  return digits ? `${whole}.${digits}` : String(whole)
}

/** Numbers from the client's fill line. The page writes its own sentence. */
export function fillParts(detail) {
  const match = String(detail).match(/got (.+?) \[(partial|full) fill: (.+?) of (.+?)\]/)
  if (!match) return null
  const executed = splitAmount(match[3])
  const total = splitAmount(match[4])
  const output = splitAmount(match[1])
  if (!executed || !total || !output || executed.symbol !== total.symbol) return null
  return {
    kind: match[2],
    executed: `${executed.amount} ${executed.symbol}`,
    total: `${total.amount} ${total.symbol}`,
    unused: `${subtractDecimal(total.amount, executed.amount)} ${executed.symbol}`,
    output: `${output.amount} ${output.symbol}`,
  }
}

export function fillSummary(fill) {
  if (!fill) return null
  return `Executed ${fill.executed} of ${fill.total}. Unused input ${fill.unused} stays in the vault. Received ${fill.output}.`
}

const TRACK_COPY = {
  committed: 'Sealed. Waiting for reveal. The order contents are not shown.',
  revealed: 'Revealed and waiting for settlement. Input that does not settle stays in the vault.',
  padding: 'Padding order. It does not move the pool tokens.',
  unfunded: 'Revealed without enough free vault balance. The deposit was not returned to you.',
  slashed: 'Nobody revealed it in time. The deposit was forfeited.',
  released: 'Closed without a reveal. The deposit was returned and the fee was kept.',
  unfilled: 'Not filled. The input was not taken and stays in the vault.',
  expired: 'The batch expired before settlement. Locked input is unlocked in the vault.',
}

/** Map a client error transcript to one sentence and a next step. The raw transcript is not returned. */
export function explainClientError(text) {
  const raw = String(text ?? '')
  const body = raw.replaceAll(/^client: /gm, '').trim()
  const say = (title, sentence, next) => ({ title, sentence, next })
  if (/one active batch per account/.test(body)) return say('One batch at a time', oneBatchReason(body), 'Wait for that batch to settle, or run cleanup to release the commitment, then review the order again.')
  if (/automatic deposits are disabled|fund the required vault balances/.test(body)) {
    const deposits = [...body.matchAll(/deposit (.+?) first/g)].map((item) => item[1])
    const exact = deposits.length ? ` Deposit ${deposits.join('; ')}.` : ''
    return say('Fund the vault first', `Fund first.${exact} This page will not deposit an order-specific shortfall.`, 'Deposit the missing amount from Funds, refresh status, then review the order again.')
  }
  if (/fund both tokens in the vault/.test(body)) return say('Fund both tokens', 'Fund first: both tokens need a non-zero balance in the vault before this page will submit an order.', 'Deposit each configured token, refresh status, then review the order again.')
  if (/not enough /.test(body)) return say('Not enough funded', 'The vault and wallet together do not cover this order, its deposit and its fee.', 'Deposit the shortfall shown in the preview, or reduce the order. This page will not deposit it for you.')
  if (/unknown token|not supported in this deployment/.test(body)) return say('Token not supported', 'That token is not supported in this deployment.', 'Use the configured pair shown next to the account.')
  if (/TokenTransferFailed|transfer amount mismatch|fee-on-transfer|rebasing/.test(body)) return say('Unsupported token transfer', 'The token did not credit the vault with the amount sent. Fee-on-transfer and rebasing tokens are refused.', 'Use a standard token from this deployment. Do not retry with the same token.')
  if (/order amounts must fit uint128/.test(body)) return say('Amount too large', 'The amount is above the uint128 cap. It was not rounded.', 'Enter a smaller amount and review again.')
  if (/no price protection/.test(body)) return say('Limit required', 'A minimum received of zero has no price protection.', 'Enter a non-zero minimum out and review again.')
  if (/is full/.test(body)) return say('Batch full', 'This batch already has the maximum number of commitments.', 'Wait for the next batch and review again.')
  if (/is not open/.test(body)) return say('Batch closed', 'That batch is not the current one.', 'Refresh status and review an order for the current batch.')
  if (/closes in /.test(body)) return say('Too late for this batch', 'The commit window is inside the client’s safety margin.', 'Wait for the next batch, then review again.')
  if (/RPC network differs/.test(body)) return say('Wrong network', 'The RPC network does not match the deployment.', 'Point the local client at the deployment’s chain and refresh status.')
  if (/differs from the settlement|token pair is not initialized/.test(body)) return say('Deployment mismatch', 'The deployment file does not match the settlement.', 'Select the deployment this chain was started with, then refresh status.')
  if (/private state is locked/.test(body)) return say('Client is busy', 'Another local client command holds this account’s state.', 'Wait for that command to finish, then try again.')
  if (/proof completed after this batch closed|preparation completed after the batch closed/.test(body)) return say('Batch closed while preparing', 'Nothing was submitted. The batch closed before the proof finished.', 'Prepare again for a later batch, then review the order.')
  if (/local prover was stopped by|out of memory|ENOMEM/.test(body)) return say('Device can’t finish the proof', 'This device ran out of memory while proving. Nothing was submitted.', 'Prepare ahead for a later batch so only the fast online proof runs, or use a machine with at least 8 GB free.')
  if (/local prover failed|local prover returned invalid JSON/.test(body)) return say('Proof failed', 'The local prover couldn’t prove this order. Nothing was submitted.', 'Check that the prover parameters match this deployment (scripts/dev.sh sets them up), then review the order again.')
  if (/local prover not found|ADMISSION_PROVER|ADMISSION_PARAMS|parameter manifest/.test(body)) return say('Local prover not set up', 'The local prover or its parameter files are missing or don’t match this deployment. Nothing was submitted.', 'Start the stack with scripts/dev.sh, which builds the prover and points the client at the parameters.')
  if (/NotCurrentBatch/.test(body)) return say('Batch closed before submission', 'The batch closed while the order was being proved or sent. Nothing was applied.', 'Prepare for the next batch, then review the order again.')
  if (/Another CLI command is running/.test(body)) return say('Already running', 'Another action is already running on this machine.', 'Wait for it to finish; its result appears here.')
  if (/run resume-admission/.test(body)) return say('Admission needs a resume', 'An admission submission did not finish.', 'Run Resume admission. It resends or reconciles the same saved proof.')
  if (/block withdrawals/.test(body)) return say('Withdrawals are blocked', 'An open commitment blocks every withdrawal.', 'Open Clear blockers, then run cleanup when its action is available.')
  if (/only .+ is withdrawable/.test(body)) return say('Above the withdrawable balance', 'That amount is higher than the withdrawable vault balance.', 'Withdraw the amount shown as withdrawable, or all.')
  if (/refusing to import/.test(body)) return say('Backup refused', 'The backup does not match this account, deployment or the commitments onchain.', 'Export a new backup from the client that submitted the order.')
  if (/does not use proof-enforced admission|requires admission/.test(body)) return say('Admission mode differs', 'This action does not match the deployment’s admission mode.', 'Refresh status and use the action this deployment shows.')
  if (/reverted in/.test(body)) return say('Transaction reverted', 'The transaction reverted. Nothing from it was applied.', 'Refresh status before trying again.')
  if (/was dropped before inclusion/.test(body)) return say('Transaction dropped', 'The transaction was dropped before inclusion. Nothing changed onchain.', 'Run the same action again.')
  if (/was cancelled by a replacement/.test(body)) return say('Transaction cancelled', 'A replacement transaction cancelled this one. Nothing from it was applied.', 'Refresh status before trying again.')
  if (/was replaced by another transaction/.test(body)) return say('Transaction replaced', 'Another transaction from this account replaced it.', 'Refresh status before trying again.')
  if (/still pending/.test(body)) return say('Still pending', 'The transaction is still pending.', 'Wait, then run the same action again later.')
  if (/preflight failed/.test(body)) return say('Order needs changes', 'The order failed the client’s checks.', 'Read the review, fix the order or the vault balance, and review again.')
  return say('Could not finish', 'The local client could not finish that action.', 'Refresh status and try again. The command output stays on this machine.')
}

export function orderSummary(row) {
  if (row.fill) return fillSummary(row.fill)
  return TRACK_COPY[row.state] ?? 'The settlement reported this commitment. Refresh tracking if the state is unfamiliar.'
}

/** Readable job text. This never returns the CLI transcript. */
export function presentJob(job, now = Date.now()) {
  if (!job) return { title: 'Ready', body: 'Run status to load this account.' }
  if (job.state === 'running') {
    const stage = jobStage(job)
    const body = stage === 'PROVING' || stage === 'PREPARING'
      ? 'The local client is proving on this machine. This page does not have the proof yet.'
      : stage === 'FINALIZING'
        ? 'Proving finished. The local client is submitting the transaction.'
        : 'The local client is working on this machine.'
    return { title: stage, body }
  }
  if (job.state === 'failed') {
    const error = explainClientError(job.output)
    return { title: error.title, body: `${error.sentence} ${error.next}` }
  }
  if (job.action === 'preflight') {
    const review = parsePreflight(job.output, now)
    if (!review) return { title: 'Preview incomplete', body: 'The preview did not include an order this page can show. Review the order again.' }
    return { title: review.ok ? 'Review this order' : 'Cannot submit yet', body: formatReview(review) }
  }
  return { title: 'Finished', body: successCopy(job) }
}

export function formatReview(review) {
  const quote = review.quote
    ? `${review.quote.label}: ${review.quote.price} token1 per token0, ${review.quote.ageSeconds}s old${review.quote.stale ? ', stale' : ''}. This is a reference, not your clearing price.`
    : 'Public pool price is not in the client status yet, so it is not shown as a live quote.'
  const fee = review.fee ? `Commit fee: ${review.fee}. It is not refunded.` : 'Commit fee was not in the preview.'
  const deposit = review.deposit
    ? `Deposit: ${review.deposit}. ${review.depositReturn ?? 'The preview did not say when it returns.'}`
    : 'Deposit was not in the preview.'
  const approvals = review.funding.filter((row) => row.approval).map((row) => row.symbol)
  const approval = approvals.length ? `The client will send an ERC-20 approval for ${approvals.join(', ')} before depositing.` : 'No new ERC-20 approval was listed.'
  const gas = review.gas ? `Estimated gas: ${review.gas} units. This is an estimate from the client, not a guarantee.` : 'Estimated gas is not reported by the client.'
  const deadlines = review.deadlines.length ? `Deadlines: ${review.deadlines.join('; ')}.` : 'Deadlines were not in the preview.'
  const block = [fundFirst(review), review.oneBatch].filter(Boolean).join(' ')
  return [
    `${review.side === 'sell' ? 'Sell' : 'Buy'} ${review.amount} for at least ${review.minimum} in batch ${review.batch}. Worst-case output is ${review.minimum}. That minimum is your limit, not a pool price.`,
    'Fills can be partial. Input that does not trade stays in the vault.',
    quote,
    liquidityNote(review.liquidity),
    deadlines,
    fee,
    deposit,
    approval,
    gas,
    block || (review.ok ? 'Nothing in this preview blocks submission.' : 'The preview reported a problem. Fix it and review again.'),
  ].join('\n')
}

function successCopy(job) {
  const text = job.output ?? ''
  if (job.action === 'commit' && /committed #(\d+)/.test(text)) {
    const id = text.match(/committed #(\d+)/)[1]
    return `Order #${id} is committed. Export a private backup so it can be revealed. Track it after settlement to see executed and unused input.`
  }
  if (job.action === 'commit' && /admitted #(\d+)/.test(text)) {
    const id = text.match(/admitted #(\d+)/)[1]
    return `Order #${id} was admitted. Export a private backup. Track it after settlement to see executed and unused input.`
  }
  if (job.action === 'deposit') {
    const amount = text.match(/deposited (.+)/)?.[1]
    return amount ? `Deposited ${amount} into the vault.` : 'The deposit finished. Refresh status to see the vault balance.'
  }
  if (job.action === 'withdraw') {
    const amount = text.match(/withdrew (.+)/)?.[1]
    return amount ? `Withdrew ${amount} from the vault.` : 'The withdrawal finished. Refresh status to see the wallet balance.'
  }
  if (job.action === 'status') return 'Account, pair and balances are updated.'
  if (job.action === 'track') return 'Order states are updated from the settlement.'
  if (job.action === 'blockers' || job.action === 'cleanup-preview') return 'Withdrawal blockers are updated.'
  if (job.action === 'cleanup') return /nothing blocks withdrawal/.test(text) ? 'Cleanup finished. Nothing blocks withdrawal.' : 'Cleanup finished. Check blockers for anything still open.'
  if (job.action === 'prepare-admission') return preparedBatch(text) ? `Prepared for batch ${preparedBatch(text)}. Refresh status before submitting.` : 'Preparation finished. Refresh status before submitting.'
  if (job.action === 'resume-admission') return /admitted #/.test(text) ? successCopy({ ...job, action: 'commit' }) : 'Admission resume finished. Refresh status.'
  if (job.action === 'backup-export') return 'A backup download was requested. Save it somewhere private, then mark it saved.'
  if (job.action === 'backup-import') return /commitment\(s\) saved/.test(text) ? 'Backup restored for this account and deployment.' : 'Backup import finished. Refresh status.'
  return 'The local command finished. Refresh status to see the result.'
}

/** Compare a deposit’s sent amount with the change in vault available balance. */
export function transferCheck({ before, after, sent }) {
  const left = splitAmount(before)
  const right = splitAmount(after)
  const amount = typeof sent === 'string' && /^\d+(?:\.\d+)?$/.test(sent.trim()) ? sent.trim() : null
  if (!left || !right || !amount || left.symbol !== right.symbol) return { checked: false }
  const received = subtractDecimal(right.amount, left.amount)
  const scale = 10n ** 18n
  const toBase = (value) => {
    const [whole, frac = ''] = value.split('.')
    return BigInt(whole) * scale + BigInt(frac.padEnd(18, '0').slice(0, 18))
  }
  const short = toBase(received) < toBase(amount)
  return {
    checked: true,
    ok: !short,
    sent: `${amount} ${left.symbol}`,
    received: `${received} ${left.symbol}`,
    message: short
      ? `The vault received ${received} ${left.symbol} after you sent ${amount} ${left.symbol}. Fee-on-transfer and rebasing tokens are not supported in this deployment.`
      : null,
  }
}

export function parseBlockers(text) {
  if (['nothing blocks withdrawal', 'dry run: nothing sent'].includes(text.trim())) return []
  const lines = text.trim().split(/\r?\n/).filter((line) => line !== 'dry run: nothing sent')
  const rows = []
  for (const line of lines) {
    const match = line.match(/^#(\d+) batch (\d+) \((committed|revealed)\): (wait -?\d+s|reveal|slash|release|expire) — (.+)$/)
    if (!match) return null
    rows.push({ id: match[1], batch: match[2], state: match[3], action: match[4], reason: match[5] })
  }
  return rows.length ? rows : null
}
