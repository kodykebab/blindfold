// Blindfold client CLI: one workflow from funding to withdrawal.
//   npm start -- status                          balances (wallet / available / reserved / withdrawable) and the open batch
//   npm start -- deposit <token0|token1> <amount>
//   npm start -- commit <sell|buy> <amountIn> [minAmountOut] [--slippage bps] [--dry-run]   preflight, encrypt, commit;
//                                                without a minimum, the limit is a fresh market quote less --slippage (default 50)
//   npm start -- resubmit [--slippage bps|keep] [--dry-run]   place the last unfilled or expired order again
//   npm start -- prepare-admission [batch-id]   prove a key wrapper before choosing the order (default: the next batch it can make)
//   npm start -- keep-ready [--once]            keep one prepared key ready for the next batch this device can make
//   npm start -- track                           every commitment of this account and what happened to it
//   npm start -- blockers                        which commitments block withdrawal and what clears each
//   npm start -- cleanup [--dry-run]             reveal own saved orders, slash unrevealed, expire unsettled batches
//   npm start -- withdraw <token0|token1> <amount|all>
//   npm start -- export-state <file>             back up saved orders and salts (needed to reveal your own orders)
//   npm start -- import-state <file>             restore them, after checking each against its hash and the chain
// sell = token0 in, token1 out; buy = token1 in, token0 out. Amounts are decimal token units.
import { formatUnits, parseEventLogs, parseUnits } from 'viem'
import { connect, encrypt, loadAbi, newSalt, orderHash } from './lib.mjs'
import { balances, deadlines, exitPlan, isOpen, preflight, track } from './flow.mjs'
import { exportState, importState, loadState, parseState, saveCommitment, validateState, writeState, withStateLock } from './state.mjs'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { proveAdmission, prepareAdmission, validatePreparation, consumePreparation, admissionLead, measuredSeconds, recordProving, targetBatch } from './admission.mjs'
import { reconcileFunding, restoreFunding } from './admission-state.mjs'
import { limitFromQuote, nextPreparation, parseSlippage, quoteOut, retryable, routeFeePpm } from './quote.mjs'

const ctx = connect()
const { dep, pub, wallet, account, abi, read } = ctx
const S = dep.settlement
const me = account.address

async function tokens() {
  const [t0, t1, depositToken] = await Promise.all([read(S, 'token0'), read(S, 'token1'), read(S, 'depositToken')])
  const meta = async (address) => {
    const [symbol, decimals] = await Promise.all(['symbol', 'decimals'].map((f) => read(address, f, [], abi.erc20)))
    return { address, symbol, decimals }
  }
  const [token0, token1, dt] = await Promise.all([meta(t0), meta(t1), meta(depositToken)])
  return { token0, token1, depositToken, byAddress: { [depositToken]: dt, [t0]: token0, [t1]: token1 } }
}
const pick = (t, name) => t[name] ?? Object.values(t.byAddress).find((x) => x.address.toLowerCase() === name?.toLowerCase())
  ?? fail(`unknown token ${name}; use token0 or token1`)
const fmt = (token, v) => `${formatUnits(v, token.decimals)} ${token.symbol}`

function fail(msg) {
  throw new Error(msg)
}

async function send(address, which, functionName, args) {
  const { request } = await pub.simulateContract({ account, address, abi: which, functionName, args })
  const hash = await wallet.writeContract(request)
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') fail(`${functionName} reverted in ${hash}`)
  return receipt
}

async function vaultView(t) {
  const open = await read(dep.vault, 'openCommitments', [me])
  const rows = await Promise.all([t.token0, t.token1].map(async (tok) => {
    const [balance, locked, walletBal] = await Promise.all([
      read(dep.vault, 'balanceOf', [me, tok.address]), read(dep.vault, 'lockedOf', [me, tok.address]),
      read(tok.address, 'balanceOf', [me], abi.erc20),
    ])
    return { tok, wallet: walletBal, ...balances({ balance, locked, open }) }
  }))
  return { open, rows }
}

const admissionRequired = async () => abi.settlement.some((f) => f.type === 'function' && f.name === 'admissionRequired')
  ? read(S, 'admissionRequired') : false

async function schedule(b) {
  const names = ['commitsClose', 'revealOpens', 'revealCloses', 'settleCloses']
  const v = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await read(S, n, [b])])))
  return deadlines(v, await admissionRequired())
}

async function status() {
  const t = await tokens()
  const { open, rows } = await vaultView(t)
  console.log(`account ${me}`)
  for (const r of rows) {
    console.log(`  ${r.tok.symbol.padEnd(6)} wallet ${fmt(r.tok, r.wallet)} | available ${fmt(r.tok, r.available)} | reserved ${fmt(r.tok, r.reserved)} | withdrawable ${fmt(r.tok, r.withdrawable)}`)
  }
  console.log(`  open commitments: ${open}${open ? ' (withdrawals blocked until each is revealed and settled, slashed, released or expired)' : ''}`)
  const [b, now] = await Promise.all([read(S, 'currentBatch'), pub.getBlock().then((x) => x.timestamp)])
  console.log(`batch ${b} (chain time ${now})`)
  for (const d of await schedule(b)) console.log(`  ${String(d.at - now).padStart(5)}s  ${d.what}`)
}

async function deposit(name, amount) {
  const t = await tokens()
  const tok = pick(t, name)
  const value = parseUnits(amount, tok.decimals)
  const allowance = await read(tok.address, 'allowance', [me, dep.vault], abi.erc20)
  if (allowance < value) await send(tok.address, abi.erc20, 'approve', [dep.vault, value])
  await send(dep.vault, abi.vault, 'deposit', [tok.address, value])
  console.log(`deposited ${fmt(tok, value)}`)
}

async function checkAdmissionNetwork() {
  if (await pub.getChainId() !== Number(dep.chainId)) fail('RPC network differs from the deployment; select the correct RPC_URL and deployment')
}

async function prepare(batchText) {
  if (batchText !== undefined && !/^\d+$/.test(batchText)) fail('usage: prepare-admission [batch-id]')
  await checkAdmissionNetwork()
  if (!await admissionRequired()) fail('this deployment does not use proof-enforced admission')
  const current = await read(S, 'currentBatch')
  let batch
  if (batchText === undefined) {
    // The earliest batch this device can prepare for and still prove an order in.
    const [close, now] = await Promise.all([read(S, 'commitsClose', [current]), pub.getBlock().then((x) => x.timestamp)])
    const proving = loadState(dep, me).proving
    const need = BigInt(measuredSeconds(proving, 'preparation') ?? 60) + admissionLead(true, process.env, proving)
    batch = close - now >= need ? current : current + 1n
  } else batch = BigInt(batchText)
  if (batch < current || batch >= 1n << 64n) fail('select an explicit current or future batch')
  const round = await read(S, 'targetRound', [batch])
  console.log(`preparing locally for batch ${batch}, round ${round}…`)
  const preparation = await prepareAdmission({ dep, owner: me, batch, round })
  if ((await pub.getBlock()).timestamp >= await read(S, 'commitsClose', [batch])) fail('preparation completed after the batch closed; select a later batch')
  await checkAdmissionNetwork()
  const state = loadState(dep, me)
  state.preparation = preparation
  recordProving(state, 'preparation', preparation.elapsedSeconds)
  writeState(dep, me, state)
  console.log(`prepared batch ${batch} in ${preparation.elapsedSeconds.toFixed(2)}s; private preparation saved locally`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const hasMarket = async () => abi.settlement.some((f) => f.type === 'function' && f.name === 'externalMarket')
  && BigInt(await read(S, 'externalMarket')) !== 0n

/**
 * A fresh quote from the deployment's external market: its validated reference price ending at the latest block, and
 * the pool fee (combined over a route's hops). Null when the deployment has no external market.
 */
async function marketQuote() {
  if (!await hasMarket()) return null
  const market = await read(S, 'externalMarket')
  const block = await pub.getBlock()
  const maxAge = process.env.QUOTE_MAX_AGE_S ?? '120'
  const age = BigInt(Math.floor(Date.now() / 1000)) - block.timestamp
  if (maxAge !== 'off' && age > BigInt(maxAge)) fail(`the RPC's latest block is ${age}s old, so a quote from it would be stale; use a current RPC_URL (or set QUOTE_MAX_AGE_S)`)
  const m = loadAbi('UniswapV3Market'), route = loadAbi('UniswapV3Route'), pool = loadAbi('IV3Pool', undefined, 'IExternalMarket')
  const call = (address, which, functionName, args = []) => pub.readContract({ address, abi: which, functionName, args })
  let priceX96
  try {
    priceX96 = await call(market, m, 'referencePrice', [block.timestamp])
  } catch (e) {
    const why = e.walk?.((x) => x.data?.errorName)?.data?.errorName ?? e.shortMessage ?? e.message
    fail(`the market cannot price this pair right now (${why}), so a batch would not settle through it either; try again shortly or give an explicit minimum`)
  }
  const feeOf = async (address) => BigInt(await call(await call(address, m, 'pool'), pool, 'fee'))
  let feePpm = 0n
  try { feePpm = await feeOf(market) } catch {
    try {
      const fees = []
      for (let i = 0n; i < await call(market, route, 'hopCount'); i++) fees.push(await feeOf(await call(market, route, 'markets', [i])))
      feePpm = routeFeePpm(fees)
    } catch {} // a market that is neither (local mocks) charges no pool fee here
  }
  return { priceX96, feePpm }
}

async function commit(side, amountIn, minOut, dryRun, slippage = 50n) {
  if (side !== 'sell' && side !== 'buy') fail('side must be sell or buy')
  if (amountIn === undefined) fail('usage: commit <sell|buy> <amountIn> [minAmountOut] [--slippage bps] [--dry-run]')
  const t = await tokens()
  const [tin, tout] = side === 'sell' ? [t.token0, t.token1] : [t.token1, t.token0]
  const order = { owner: me, zeroForOne: side === 'sell', amountIn: parseUnits(amountIn, tin.decimals), minAmountOut: 0n }
  if (minOut === undefined) {
    const q = await marketQuote()
    if (!q) fail('this deployment has no external market to quote from; give the minimum output: commit <sell|buy> <amountIn> <minAmountOut>')
    const quoted = quoteOut({ zeroForOne: order.zeroForOne, amountIn: order.amountIn, priceX96: q.priceX96, feePpm: q.feePpm })
    order.minAmountOut = limitFromQuote(quoted, slippage)
    console.log(`quote: ${fmt(tin, order.amountIn)} ≈ ${fmt(tout, quoted)} at the market reference${q.feePpm ? `, after the ${Number(q.feePpm) / 1e4}% pool fee` : ''}; limit ${slippage} bps below it`)
  } else order.minAmountOut = parseUnits(minOut, tout.decimals)
  const has = (n) => abi.settlement.some((f) => f.type === 'function' && f.name === n)
  const [current, depositAmount, maxCommits, now] = await Promise.all([
    read(S, 'currentBatch'), read(S, 'depositAmount'), read(S, 'MAX_COMMITS'), pub.getBlock().then((x) => x.timestamp)])
  const fee = has('commitFee') ? await read(S, 'commitFee') : 0n // REVIEW R3: not every deployment charges one yet
  const [commitsClose, commits] = await Promise.all([read(S, 'commitsClose', [current]), read(S, 'commitIdsOf', [current])])
  const per = async (f) => Object.fromEntries(await Promise.all(Object.keys(t.byAddress).map(async (a) => [a, await f(a)])))
  const enforced = await admissionRequired()
  let funding, minLead = 3n, target = { batch: current, prepared: false, close: commitsClose }
  if (enforced) {
    await checkAdmissionNetwork()
    if (!dep.admission?.manifestSha256) fail('this deployment requires admission; its deployment file must include the parameter manifest')
    const state = loadState(dep, me)
    funding = reconcileFunding(dep, me, state.admission, await fundingOnchain(), now)
    let preparedBatch
    if (state.preparation) {
      const pb = BigInt(state.preparation.batch)
      if (pb < current) {
        console.log(`the ready preparation was for batch ${pb}, which has closed; it is discarded`)
        delete state.preparation
      } else {
        validatePreparation(state.preparation, { dep, owner: me, batch: pb, round: await read(S, 'targetRound', [pb]) })
        preparedBatch = pb
      }
    }
    // Prove for the current batch if this device has time, else for the next one and submit as it opens.
    const lead = { online: admissionLead(true, process.env, state.proving), inline: admissionLead(false, process.env, state.proving) }
    target = targetBatch({ current, commitsClose, batchLength: BigInt(await read(S, 'batchLength')), now, preparedBatch, lead })
      ?? fail(`not enough time to prove before batch ${current + 1n} closes on this device (needs ${lead.inline}s)`)
    minLead = target.prepared ? lead.online : lead.inline
    if (target.batch !== current) {
      console.log(`batch ${current} closes in ${commitsClose - now}s, too soon to prove here (needs ${minLead}s): the order goes into batch ${target.batch} and is submitted when it opens`)
    }
    state.admission = funding
    if (!dryRun) writeState(dep, me, state)
  }
  const targetCommits = target.batch === current ? commits : await read(S, 'commitIdsOf', [target.batch])
  const check = preflight({
    cumulative: enforced ? { [t.token0.address]: funding.totals[0], [t.token1.address]: funding.totals[1] } : {},
    minLead,
    order, tokenIn: tin.address, depositToken: t.depositToken, depositAmount, fee,
    free: await per((a) => read(dep.vault, 'freeBalance', [me, a])),
    wallet: await per((a) => read(a, 'balanceOf', [me], abi.erc20)),
    allowance: await per((a) => read(a, 'allowance', [me, dep.vault], abi.erc20)),
    batch: { id: target.batch, current, commitsClose: target.close, now, commits: BigInt(targetCommits.length), maxCommits },
    openBatches: [...new Set([...(await myCommitments()).values()].filter(isOpen).map((c) => c.batchId))],
  })
  const dt = t.byAddress[t.depositToken]
  console.log(`order: ${side} ${fmt(tin, order.amountIn)} for at least ${fmt(tout, order.minAmountOut)} in batch ${target.batch}, or you keep your funds`)
  console.log(`costs: deposit ${fmt(dt, depositAmount)} (returned minus the revealer's bounty when revealed), fee ${fmt(dt, fee)}`)
  for (const f of check.funding) {
    const tok = t.byAddress[f.token]
    console.log(`funding ${tok.symbol}: need ${fmt(tok, f.need)}, vault free ${fmt(tok, f.free)}${f.shortfall ? `, deposit ${fmt(tok, f.shortfall)} first${f.approve ? ' (needs approval)' : ''}` : ''}`)
  }
  for (const d of await schedule(target.batch)) console.log(`  ${String(d.at - now).padStart(5)}s  ${d.what}`)
  if (!enforced) console.log(`keep ${fmt(tin, order.amountIn)} free in the vault until the reveal, or the order is closed as unfunded and the deposit lost`)
  if (!check.ok) fail(`preflight failed:\n  ${check.problems.join('\n  ')}`)
  if (dryRun) return console.log('dry run: nothing sent')
  for (const f of check.funding) {
    if (!f.shortfall) continue
    if (f.approve) await send(f.token, abi.erc20, 'approve', [dep.vault, f.shortfall])
    await send(dep.vault, abi.vault, 'deposit', [f.token, f.shortfall])
  }
  const salt = newSalt()
  const hash = orderHash(dep.chainId, S, target.batch, order, salt)
  const round = await read(S, 'targetRound', [target.batch])
  if (enforced) {
    const budgets = await Promise.all([t.token0, t.token1].map(async (tok) => {
      const free = await read(dep.vault, 'freeBalance', [me, tok.address])
      return free - (tok.address.toLowerCase() === t.depositToken.toLowerCase() ? depositAmount + fee : 0n)
    }))
    const prepared = target.prepared
      ? consumePreparation(loadState(dep, me), { dep, owner: me, batch: target.batch, round }, (state) => writeState(dep, me, state))
      : undefined
    console.log(prepared ? 'generating the online admission proof locally…' : 'generating both admission proofs locally…')
    const result = await proveAdmission({ dep, owner: me, batch: target.batch, round, funding, budgets, order, salt, prepared })
    console.log(`local proving completed in ${result.timings.elapsedSeconds.toFixed(2)}s`)
    {
      // Measure before the deadline check: a slow device must learn from the attempt it missed.
      const state = loadState(dep, me)
      recordProving(state, prepared ? 'online' : 'inline', result.timings.elapsedSeconds)
      writeState(dep, me, state)
    }
    await checkAdmissionNetwork()
    const latest = (await pub.getBlock()).timestamp
    if (latest >= target.close) fail(`proof completed after batch ${target.batch} closed; nothing submitted. This device's margin now reflects the slower proof; commit again`)
    reconcileFunding(dep, me, funding, await fundingOnchain(), latest)
    const state = loadState(dep, me)
    state.commitments.push({ id: null, batchId: target.batch, round, hash, order, salt })
    state.admission = { ...funding, pending: { ...result, batch: target.batch, closes: target.close } }
    writeState(dep, me, state)
    if (target.batch !== current) await untilOpen(target.batch, target.close)
    return resumeAdmission()
  }
  const ciphertext = await encrypt(round, order, salt)
  saveCommitment(dep, me, { id: null, batchId: current, round, hash, order, salt }) // before sending: never lose the salt
  const receipt = await send(S, abi.settlement, 'commit', [current, hash, ciphertext])
  const [ev] = parseEventLogs({ abi: abi.settlement, logs: receipt.logs, eventName: 'Committed' })
  saveCommitment(dep, me, { id: ev.args.commitId, hash, tx: receipt.transactionHash })
  console.log(`committed #${ev.args.commitId} to round ${round} in ${receipt.transactionHash}`)
}


/**
 * Wait for `batch` to become current. Chain time moves only when a block is mined, so wall-clock time since the latest
 * block stands in for it; then poll until a block carries the new batch's time, up to its own close.
 */
async function untilOpen(batch, close) {
  const opens = await read(S, 'commitsClose', [batch - 1n])
  const base = (await pub.getBlock()).timestamp, started = Date.now()
  const chainNow = () => base + BigInt(Math.floor((Date.now() - started) / 1000))
  if (chainNow() < opens) console.log(`proof ready; submitting when batch ${batch} opens in ${opens - chainNow()}s`)
  while (chainNow() < opens) await new Promise((r) => setTimeout(r, Math.min(Number(opens - chainNow()) * 1000, 2000)))
  // A live chain mines a block in the new batch within seconds; an idle one never does, so give up after a minute.
  const giveUp = opens + 60n < close ? opens + 60n : close
  while (await read(S, 'currentBatch') !== batch) {
    if (chainNow() >= giveUp) fail(`no block in batch ${batch} yet; the proof is saved: run resume-admission while batch ${batch} is open`)
    await new Promise((r) => setTimeout(r, 1000))
  }
}

async function fundingOnchain() {
  const [batch, root, step] = await read(S, 'admissionState', [me])
  return { batch, root, step }
}

async function resumeAdmission() {
  await checkAdmissionNetwork()
  if (!dep.admission?.manifestSha256 || !await admissionRequired()) fail('this deployment does not use proof-enforced admission')
  const state = loadState(dep, me)
  const chain = await fundingOnchain(), now = (await pub.getBlock()).timestamp
  const pending = state.admission?.pending
  if (!pending) {
    state.admission = reconcileFunding(dep, me, state.admission, chain, now)
    writeState(dep, me, state)
    return console.log('private funding state matches the chain')
  }
  try {
    state.admission = reconcileFunding(dep, me, state.admission, chain, now)
    writeState(dep, me, state)
    return console.log('pending admission reconciled with chain state')
  } catch (e) { if (!e.message.includes('run resume-admission')) throw e }
  let tx = pending.tx
  if (!tx) {
    const { request } = await pub.simulateContract({ account, address: S, abi: abi.settlement, functionName: 'admit', args: [pending.batch, pending.hash, pending.ciphertext, pending.proof] })
    tx = await wallet.writeContract(request)
    state.admission.pending.tx = tx
    writeState(dep, me, state)
  }
  const receipt = await pub.waitForTransactionReceipt({ hash: tx })
  if (receipt.status !== 'success') fail(`admission reverted in ${tx}; pending state retained until its batch closes`)
  const [ev] = parseEventLogs({ abi: abi.settlement, logs: receipt.logs, eventName: 'Committed' })
  if (!ev || ev.args.hash !== pending.hash) fail('admission receipt did not contain the expected commitment; pending state retained')
  const c = state.commitments.find((c) => c.hash === pending.hash)
  if (c) Object.assign(c, { id: ev.args.commitId, tx })
  state.admission = reconcileFunding(dep, me, state.admission, await fundingOnchain(), (await pub.getBlock()).timestamp)
  writeState(dep, me, state)
  console.log(`admitted #${ev.args.commitId} in ${tx}`)
}

const myCommitments = async () =>
  track(await pub.getContractEvents({ address: S, abi: abi.settlement, fromBlock: BigInt(dep.deployBlock ?? 0) }), me)

async function trackAll() {
  const t = await tokens()
  const mine = await myCommitments()
  if (!mine.size) return console.log('no commitments')
  for (const c of mine.values()) {
    const o = c.order
    const what = o ? `${o.zeroForOne ? 'sell' : 'buy'} ${o.amountIn}` : 'sealed'
    const fill = c.state === 'filled' ? ` → got ${fmt(o.zeroForOne ? t.token1 : t.token0, c.amountOut)}` : ''
    console.log(`#${c.id} batch ${c.batchId}: ${c.state} (${what})${fill}`)
  }
}

async function exitSteps() {
  const open = [...(await myCommitments()).values()].filter(isOpen)
  const now = (await pub.getBlock()).timestamp
  const sched = new Map()
  for (const b of new Set(open.map((c) => c.batchId))) {
    const [revealOpens, revealCloses, settleCloses] = await Promise.all(['revealOpens', 'revealCloses', 'settleCloses'].map((f) => read(S, f, [b])))
    sched.set(b, { revealOpens, revealCloses, settleCloses })
  }
  // by hash, so an entry saved before its commit landed (no id yet) still counts
  const kept = new Map(loadState(dep, me).commitments.map((x) => [x.hash, x]))
  return { now, kept, steps: exitPlan(open, { now, sched, saved: new Set(kept.keys()), admissionRequired: await admissionRequired() }) }
}

const describe = ({ c, action, at, why }, now) =>
  `#${c.id} batch ${c.batchId} (${c.state}): ${action === 'wait' ? `wait ${at - now}s` : action} — ${why}`

async function blockers() {
  const { now, steps } = await exitSteps()
  if (!steps.length) return console.log('nothing blocks withdrawal')
  for (const s of steps) console.log(describe(s, now))
}

/** Guided exit: one transaction per step, in order; reports what still blocks withdrawal. */
async function cleanup(dryRun) {
  const { now, kept, steps } = await exitSteps()
  const expired = new Set()
  for (const s of steps) {
    console.log(describe(s, now))
    if (dryRun || s.action === 'wait') continue
    const { id, batchId } = s.c
    if (s.action === 'reveal') await send(S, abi.settlement, 'reveal', [id, kept.get(s.c.hash).order, kept.get(s.c.hash).salt])
    if (s.action === 'slash' || s.action === 'release') await send(S, abi.settlement, 'slashUnrevealed', [id])
    if (s.action === 'expire' && !expired.has(batchId)) {
      expired.add(batchId)
      await send(S, abi.settlement, 'expire', [batchId])
    }
  }
  if (dryRun) return console.log('dry run: nothing sent')
  const open = await read(dep.vault, 'openCommitments', [me])
  console.log(open ? `${open} commitment(s) still block withdrawal; run blockers` : 'nothing blocks withdrawal')
}

async function withdraw(name, amount) {
  const t = await tokens()
  const tok = pick(t, name)
  const { open, rows } = await vaultView(t)
  if (open) {
    const { now, steps } = await exitSteps()
    fail(`${open} open commitment(s) block withdrawals of every token:\n  ${steps.map((s) => describe(s, now)).join('\n  ')}\nrun cleanup`)
  }
  const row = rows.find((r) => r.tok === tok)
  const value = amount === 'all' ? row.withdrawable : parseUnits(amount, tok.decimals)
  if (value > row.withdrawable) fail(`only ${fmt(tok, row.withdrawable)} is withdrawable`)
  await send(dep.vault, abi.vault, 'withdraw', [tok.address, value])
  console.log(`withdrew ${fmt(tok, value)}`)
}

function exportCmd(file) {
  if (!file) fail('usage: export-state <file>')
  writeFileSync(file, exportState(dep, me), { mode: 0o600 })
  chmodSync(file, 0o600)
  console.log(`exported ${loadState(dep, me).commitments.length} commitment(s) to ${file}`)
}

async function importCmd(file) {
  if (!file) fail('usage: import-state <file>')
  const state = parseState(readFileSync(file, 'utf8'))
  const chainHashes = new Map()
  for (const c of state.commitments ?? []) {
    if (c.id != null) chainHashes.set(c.id, (await read(S, 'commitments', [c.id]))[3])
  }
  const problems = validateState(state, { dep, owner: me, orderHash, chainHashes })
  if (problems.length) fail(`refusing to import ${file}:\n  ${problems.join('\n  ')}`)
  if (await admissionRequired()) {
    state.admission = restoreFunding(dep, me, state.admission, await fundingOnchain(), (await pub.getBlock()).timestamp)
    const local = loadState(dep, me)
    if (local.admission?.pending) fail('resolve the local pending admission before importing another state')
  }
  console.log(`imported; ${importState(dep, me, state)} commitment(s) saved`)
}

/** Place the most recent unfilled or expired order again: re-quoted when the deployment has a market, else same limit. */
async function resubmit(dryRun, slippageText) {
  const t = await tokens()
  const r = retryable(await myCommitments(), loadState(dep, me).commitments)
  if (!r) fail('no unfilled or expired order to resubmit')
  const o = r.saved.order
  const [tin, tout] = o.zeroForOne ? [t.token0, t.token1] : [t.token1, t.token0]
  const requote = slippageText !== 'keep' && await hasMarket()
  console.log(`resubmitting #${r.tracked.id} (${r.tracked.state} in batch ${r.tracked.batchId}): ${o.zeroForOne ? 'sell' : 'buy'} ${fmt(tin, o.amountIn)}${requote ? ' with a fresh quote' : ` at the same limit, ${fmt(tout, o.minAmountOut)}`}; a new commitment pays the commit fee again`)
  await commit(o.zeroForOne ? 'sell' : 'buy', formatUnits(o.amountIn, tin.decimals), requote ? undefined : formatUnits(o.minAmountOut, tout.decimals),
    dryRun, parseSlippage(requote && slippageText !== undefined ? slippageText : '50'))
  if (dryRun) return
  const state = loadState(dep, me)
  const old = state.commitments.find((c) => c.hash === r.saved.hash)
  const latest = state.commitments.at(-1)
  if (old && latest && latest.hash !== old.hash) {
    old.resubmittedAs = latest.hash
    writeState(dep, me, state)
  }
}

/** Keep one preparation ready for the earliest batch this device can still make; --once does one check and exits. */
async function keepReady(once) {
  await checkAdmissionNetwork()
  if (!await admissionRequired()) fail('this deployment does not use proof-enforced admission')
  if (!once) console.log('keeping a prepared key ready: about one preparation of CPU each time a key is used or its batch passes')
  for (;;) {
    const state = loadState(dep, me)
    const current = await read(S, 'currentBatch')
    const [close, now, batchLength] = await Promise.all([read(S, 'commitsClose', [current]), pub.getBlock().then((x) => x.timestamp), read(S, 'batchLength')])
    const prepBatch = state.preparation?.batch
    const batch = nextPreparation({ prepBatch, current, commitsClose: close, batchLength, now,
      preparation: measuredSeconds(state.proving, 'preparation') ?? 60, online: admissionLead(true, process.env, state.proving) })
    if (batch === null) console.log(`a key for batch ${prepBatch} is ready`)
    else await withStateLock(dep, me, () => prepare(String(batch)))
    if (once) return
    await sleep(Number(process.env.KEEP_READY_POLL_MS ?? 10_000))
  }
}

const [cmd, ...args] = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--slippage')
const commands = {
  status: () => status(),
  deposit: () => deposit(args[0], args[1]),
  commit: () => commit(positional[0], positional[1], positional[2], args.includes('--dry-run'), parseSlippage(flag('--slippage') ?? '50')),
  resubmit: () => resubmit(args.includes('--dry-run'), flag('--slippage')),
  'keep-ready': () => keepReady(args.includes('--once')),
  track: () => trackAll(),
  'prepare-admission': () => prepare(args[0]),
  'resume-admission': () => resumeAdmission(),
  blockers: () => blockers(),
  cleanup: () => cleanup(args.includes('--dry-run')),
  withdraw: () => withdraw(args[0], args[1] ?? 'all'),
  'export-state': () => exportCmd(args[0]),
  'import-state': () => importCmd(args[0]),
}
if (!commands[cmd]) fail(`usage: npm start -- <${Object.keys(commands).join('|')}> ...`)
try {
  // keep-ready takes the lock only while it prepares, so the same account can commit while it runs
  const mutates = ['prepare-admission', 'commit', 'resubmit', 'resume-admission', 'import-state', 'cleanup', 'withdraw', 'deposit'].includes(cmd)
  await (mutates ? withStateLock(dep, me, commands[cmd]) : commands[cmd]())
}
catch (e) { console.error(`client: ${e.shortMessage ?? e.message}`); process.exitCode = 1 }
