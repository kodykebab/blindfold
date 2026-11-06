import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseStatus, jobStage, preparedBatch, parseTrack, parseBlockers, displayPair, balanceFields, validateAmount, amountLimits,
  parseQuote, stampQuote, parsePreflight, reviewChanges, explainClientError, presentJob, transferCheck, fillSummary, liquidityNote, quoteFromJson, quoteLine,
  batchPhase, mempoolView, fundFirst, QUOTE_STALE_SECONDS,
} from './status.mjs'

test('status report preserves actual balances, batch and deadlines', () => {
  const value = parseStatus(`account 0x1111111111111111111111111111111111111111\nnetwork 31337\npair TKA / TKB\n  TKA    wallet 100 TKA | available 5 TKA | reserved 10 TKA | withdrawable 0 TKA\n  TKB    wallet 2 TKB | available 1 TKB | reserved 0 TKB | withdrawable 0 TKB\n  open commitments: 1 (withdrawals blocked)\nbatch 7 (chain time 1234)\n    20s commits close\n    -4s reveal opens\npreparation: prepared for batch 8\n`)
  assert.equal(value.account, '0x1111111111111111111111111111111111111111')
  assert.equal(value.network, 'network 31337')
  assert.equal(value.pair, 'pair TKA / TKB')
  assert.equal(value.rows[0].reserved, '10 TKA')
  assert.equal(value.rows[1].withdrawable, '0 TKB')
  assert.equal(value.batch, 'batch 7 (chain time 1234)')
  assert.equal(value.preparation, 'preparation: prepared for batch 8')
  assert.deepEqual(value.deadlines, ['20s commits close', '-4s reveal opens'])
})
test('status JSON is read first and still fills the text-shaped view', () => {
  const value = parseStatus(JSON.stringify({
    account: '0x1111111111111111111111111111111111111111',
    chainId: 31337,
    pair: {
      token0: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'TKA', decimals: 18 },
      token1: { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', symbol: 'TKB', decimals: 6 },
    },
    balances: [
      { token: 'token0', wallet: '100', available: '20', reserved: '0', withdrawable: '20' },
      { token: 'token1', wallet: '5', available: '1', reserved: '2', withdrawable: '0' },
    ],
    openCommitments: 1,
    batch: { id: '3', now: 1700000000, deadlines: [{ at: 1700000060, what: 'commits close' }] },
    preparation: 'none',
    quote: null,
  }))
  assert.equal(value.account, '0x1111111111111111111111111111111111111111')
  assert.equal(value.pair, 'pair TKA / TKB')
  assert.equal(value.rows[0].wallet, '100 TKA')
  assert.equal(value.rows[1].reserved, '2 TKB')
  assert.match(value.open, /open commitments: 1/)
  assert.deepEqual(value.deadlines, ['60s  commits close'])
  assert.equal(value.preparation, 'preparation: none')
  assert.equal(value.tokens[0].decimals, 18)
  assert.equal(value.tokens[1].decimals, 6)
})

test('incomplete or error output is not presented as a successful status', () => {
  assert.equal(parseStatus('client: deployment is missing'), null)
  assert.equal(parseStatus('account 0x1111111111111111111111111111111111111111\nbatch 0 (chain time 0)'), null)
})

test('progress labels only follow actual CLI output', () => {
  assert.equal(jobStage({ action: 'commit', output: 'order: sell' }), 'RUNNING')
  assert.equal(jobStage({ action: 'commit', output: 'generating the online admission proof locally…' }), 'PROVING')
  assert.equal(jobStage({ action: 'commit', output: 'local proving completed in 90s' }), 'FINALIZING')
  assert.equal(jobStage({ action: 'prepare-admission', output: 'preparing locally for batch 2' }), 'PREPARING')
})

test('prepared badge only uses an actual successful CLI preparation message', () => {
  assert.equal(preparedBatch('preparing locally for batch 4…'), null)
  assert.equal(preparedBatch('prepared batch 4 in 100.0s; private preparation saved locally'), '4')
})

test('tracking displays reported states and distinguishes explicitly reported partial fills', () => {
  const rows = parseTrack('#0 batch 2: committed (sealed)\n#1 batch 2: filled (sell 10) → got 3 TKB [partial fill: 4 TKA of 10 TKA]')
  assert.equal(rows[0].state, 'committed')
  assert.equal(rows[1].state, 'partially filled')
  assert.match(rows[1].detail, /4 TKA of 10 TKA/)
  assert.deepEqual(parseTrack('no commitments'), [])
  assert.equal(parseTrack('unrecognized result'), null)
})

test('pair display uses symbols and shortens addresses', () => {
  const named = parseStatus(`account 0x1111111111111111111111111111111111111111\nnetwork 31337\npair TKA / TKB\n  TKA    wallet 1 TKA | available 1 TKA | reserved 0 TKA | withdrawable 1 TKA\n  TKB    wallet 1 TKB | available 1 TKB | reserved 0 TKB | withdrawable 1 TKB\n  open commitments: 0\nbatch 1 (chain time 1)\n`)
  assert.deepEqual(displayPair(named), { label: 'TKA / TKB', symbols: ['TKA', 'TKB'], source: 'symbol' })
  const addressed = parseStatus(`account 0x1111111111111111111111111111111111111111\nnetwork 31337\npair 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa / 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n  0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa    wallet 1 A | available 1 A | reserved 0 A | withdrawable 1 A\n  0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb    wallet 1 B | available 1 B | reserved 0 B | withdrawable 1 B\n  open commitments: 0\nbatch 1 (chain time 1)\n`)
  assert.equal(displayPair(addressed).label, '0xaaaa…aaaa / 0xbbbb…bbbb')
  assert.equal(displayPair(addressed).source, 'address')
  assert.equal(named.tokens.length, 0)
  const withMeta = parseStatus(`${named ? '' : ''}account 0x1111111111111111111111111111111111111111\nnetwork 1\npair TKA / TKB\ntoken0 TKA 18 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\ntoken1 TKB 6 0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n  TKA    wallet 1 TKA | available 1 TKA | reserved 0 TKA | withdrawable 1 TKA\n  TKB    wallet 1 TKB | available 1 TKB | reserved 0 TKB | withdrawable 1 TKB\n  open commitments: 0\nbatch 1 (chain time 1)\n`)
  assert.equal(withMeta.tokens[1].decimals, 6)
})

test('balance fields keep wallet, vault, reserved and withdrawable apart', () => {
  const fields = balanceFields({ wallet: '1 TKA', available: '2 TKA', reserved: '3 TKA', withdrawable: '0 TKA' })
  assert.deepEqual(fields.map((field) => field.label), ['Wallet', 'Available (vault)', 'Reserved (open commitments)', 'Withdrawable'])
  assert.equal(fields[2].value, '3 TKA')
})

test('amount validator rejects extra precision and the uint128 cap without rounding', () => {
  assert.match(amountLimits(6), /6 decimal places/)
  assert.match(amountLimits(null), /not in the client status/)
  assert.equal(validateAmount('1.123456', { decimals: 6 }).ok, true)
  assert.match(validateAmount('1.1234567', { decimals: 6 }).message, /not rounded/)
  assert.match(validateAmount('1.1234567890123456789', { decimals: null }).message, /not round/)
  assert.match(validateAmount('0', { decimals: 18 }).message, /1 base unit/)
  assert.match(validateAmount('1e2', { decimals: 18 }).message, /plain decimal/)
  assert.equal(validateAmount('all', { allowAll: true }).ok, true)
  const huge = `${'9'.repeat(40)}`
  assert.match(validateAmount(huge, { decimals: 0 }).message, /uint128/)
  assert.equal(validateAmount('1', { decimals: 18 }).capChecked, true)
})

test('quote parser prefers the external reference and marks it stale', () => {
  const now = 10_000
  const quote = parseQuote('quote pool 1.10 age 3s\nquote external 1.20 age 4s\n', now)
  assert.equal(quote.source, 'external')
  assert.equal(quote.price, '1.20')
  assert.equal(quote.stale, false)
  const later = stampQuote(quote, now + (QUOTE_STALE_SECONDS + 2) * 1000)
  assert.equal(later.stale, true)
  assert.equal(later.ageSeconds, 4 + QUOTE_STALE_SECONDS + 2)
  assert.equal(parseQuote('order: sell 1 TKA for at least 1 TKB in batch 1'), null)
})

test('dry-run JSON keeps the contract source and does not invent an execution estimate', () => {
  const extra = {
    quote: {
      pool: { price: '1', source: 'BlindfoldSettlement.poolPriceX96', blockNumber: '4', at: 1 },
      external: { price: null, reason: 'ExternalConfig', source: 'BlindfoldSettlement.referencePriceX96', blockNumber: '4', at: 1 },
      liquidity: { raw: '99', label: 'pool liquidity (v4 units)', source: 'BlindfoldSettlement.poolLiquidity', blockNumber: '4', at: 1, estimate: null, estimateReason: 'estimate not available' },
    },
    gas: { eth: '0.00021', units: '21000', source: 'estimateContractGas(commit) * eth_gasPrice', blockNumber: '4', at: 1 },
  }
  const review = parsePreflight(`order: sell 1 TKA for at least 1 TKB in batch 1\n${JSON.stringify(extra)}`, 0)
  assert.equal(review.quote.price, '1')
  assert.equal(review.quote.source, 'pool')
  assert.equal(review.quote.ageSeconds, 0)
  assert.equal(review.liquidity.raw, '99')
  assert.match(liquidityNote(review.liquidity), /Pool liquidity \(v4 units\): 99/)
  assert.match(liquidityNote(review.liquidity), /estimate not available/)
  assert.equal(review.gasDetail.eth, '0.00021')
  assert.match(quoteLine(review.quote, review.quoteRaw), /Source: BlindfoldSettlement.poolPriceX96, block 4/)
  assert.match(quoteLine(review.quote, review.quoteRaw), /ExternalConfig/)
  const missing = quoteFromJson({ pool: { price: null, reason: 'no pool' }, external: { price: null, reason: 'ExternalPrice' } })
  assert.equal(missing, null)
})

const PREVIEW = `order: sell 10 TKA for at least 9 TKB in batch 7
costs: deposit 5 DT (returned minus the revealer's bounty when revealed), fee 0.1 DT
funding TKA: need 10 TKA, vault free 8 TKA, deposit 2 TKA first (needs approval)
funding DT: need 5.1 DT, vault free 5.1 DT
    20s  commits close
    26s  drand round out: anyone can reveal
quote pool 1.5 age 2s
liquidity 1000 estimate 9.2 TKB
gas estimate 180000
dry run: nothing sent`

test('preflight review restates the order, fee, deposit, approval and gas', () => {
  const review = parsePreflight(PREVIEW, 0)
  assert.equal(review.side, 'sell')
  assert.equal(review.minimum, '9 TKB')
  assert.equal(review.batch, '7')
  assert.equal(review.fee, '0.1 DT')
  assert.match(review.depositReturn, /reveal/)
  assert.equal(review.funding[0].approval, true)
  assert.equal(review.funding[0].shortfall, '2 TKA')
  assert.equal(review.gas, '180000')
  assert.equal(review.quote.price, '1.5')
  assert.match(liquidityNote(review.liquidity), /estimate, not guaranteed/i)
  assert.match(fundFirst(review), /Fund first: deposit 2 TKA/)
  assert.equal(review.ok, false)
})

test('a changed balance or a stale quote requires another confirm', () => {
  const before = parsePreflight(PREVIEW, 0)
  const after = parsePreflight(PREVIEW.replace('vault free 8 TKA', 'vault free 7 TKA').replace('age 2s', 'age 40s'), 0)
  const changes = reviewChanges(before, after)
  assert.match(changes.join('\n'), /Available TKA changed from 8 TKA to 7 TKA/)
  assert.match(changes.join('\n'), /stale/)
})

test('one active batch is a submission block with a reason', () => {
  const text = `${PREVIEW}\npreflight failed:\n  open commitments in batch 3: one active batch per account; wait for it to finish or run cleanup`
  const review = parsePreflight(text, 0)
  assert.match(review.oneBatch, /batch 3/)
  assert.match(explainClientError(text).next, /cleanup/)
})

test('partial fills report executed and unused input from the fill numbers', () => {
  const rows = parseTrack('#1 batch 2: filled (sell 10) → got 3 TKB [partial fill: 4 TKA of 10 TKA]')
  assert.equal(rows[0].fill.unused, '6 TKA')
  assert.match(fillSummary(rows[0].fill), /Executed 4 TKA of 10 TKA/)
  assert.match(rows[0].summary, /stays in the vault/)
  assert.doesNotMatch(rows[0].summary, /→ got/)
})

test('client errors become a sentence and a next step', () => {
  const shown = presentJob({ state: 'failed', action: 'commit', output: 'client: fund the required vault balances before trading; automatic deposits are disabled' })
  assert.match(shown.body, /will not deposit/)
  assert.doesNotMatch(shown.body, /client:/)
  assert.match(presentJob({ state: 'running', action: 'commit', output: 'generating the online admission proof locally…' }).body, /proving/)
  assert.match(explainClientError('client: unknown token USDC; use token0 or token1').sentence, /not supported/)
})

test('a short vault credit is treated as a fee-on-transfer or rebasing token', () => {
  const bad = transferCheck({ before: '1 TKA', after: '1.5 TKA', sent: '1' })
  assert.equal(bad.ok, false)
  assert.match(bad.message, /Fee-on-transfer/)
  assert.equal(transferCheck({ before: '1 TKA', after: '2 TKA', sent: '1' }).ok, true)
  assert.equal(transferCheck({ before: 'n/a', after: '2 TKA', sent: '1' }).checked, false)
})

test('batch phase and mempool use only public schedule and counts', () => {
  assert.equal(batchPhase(['20s commits close', '26s drand round out: anyone can reveal']).phase, 'committing')
  assert.equal(batchPhase(['-2s commits close', '-1s drand round out: anyone can reveal', '10s reveal window ends']).phase, 'reveal window')
  const view = mempoolView([{ state: 'committed' }, { state: 'revealed' }, { state: 'committed' }])
  assert.equal(view.committed, 2)
  assert.match(view.note, /count only/)
})

test('withdrawal blockers preserve the actual action and policy explanation', () => {
  const rows = parseBlockers('#7 batch 2 (committed): wait 12s — sealed until its drand round\n#8 batch 2 (revealed): expire — nobody settled the batch')
  assert.equal(rows[0].action, 'wait 12s')
  assert.equal(rows[1].action, 'expire')
  assert.deepEqual(parseBlockers('nothing blocks withdrawal'), [])
  assert.equal(parseBlockers('unknown output'), null)
})

test('prover, deadline and busy failures each get a sentence and a next step', () => {
  const cases = [
    ['client: local prover was stopped by SIGKILL; this device may not have enough free memory to prove', /Device can’t finish/, /8 GB|Prepare ahead/],
    ['client: local prover not found or not executable at /x/local-prover; set ADMISSION_PROVER to a built local-prover', /not set up/, /scripts\/dev.sh/],
    ['client: deployment must pin the local admission parameter manifest', /not set up/, /scripts\/dev.sh/],
    ['client: local prover failed (1); check the local parameter files and request', /Proof failed/, /review/],
    ['client: The contract function "admit" reverted with the following reason:\nNotCurrentBatch(1, 2)', /Batch closed/, /next batch/],
    ['Another CLI command is running', /Already running/, /Wait/],
  ]
  for (const [text, title, next] of cases) {
    const e = explainClientError(text)
    assert.match(e.title, title, text); assert.match(e.next, next, text)
  }
})
