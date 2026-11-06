// Blindfold client CLI: one workflow from funding to withdrawal.
//   npm start -- status                          balances (wallet / available / reserved / withdrawable) and the open batch
//   npm start -- deposit <token0|token1> <amount>
//   npm start -- commit <sell|buy> <amountIn> <minAmountOut> [--dry-run]   preflight, encrypt, commit
//   npm start -- prepare-admission <batch-id>   prove a key wrapper before choosing the order
//   npm start -- track                           every commitment of this account and what happened to it
//   npm start -- blockers                        which commitments block withdrawal and what clears each
//   npm start -- cleanup [--dry-run]             reveal own saved orders, slash unrevealed, expire unsettled batches
//   npm start -- withdraw <token0|token1> <amount|all>
//   npm start -- export-state <file>             back up saved orders and salts (needed to reveal your own orders)
//   npm start -- import-state <file>             restore them, after checking each against its hash and the chain
// sell = token0 in, token1 out; buy = token1 in, token0 out. Amounts are decimal token units.
import { encodeFunctionData, formatUnits, parseEventLogs, parseUnits } from 'viem'
import { connect, encrypt, newSalt, orderHash } from './lib.mjs'
import { balances, deadlines, exitPlan, fillDescription, isOpen, preflight, track } from './flow.mjs'
import { exportState, importState, loadState, parseState, saveCommitment, validateState, writeState, withStateLock } from './state.mjs'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { confirmTx, confirmationsFor, describeOutcome } from './tx.mjs'
import { proveAdmission, prepareAdmission, validatePreparation, consumePreparation, admissionLead } from './admission.mjs'
import { reconcileFunding, restoreFunding } from './admission-state.mjs'
import { cleanSymbol, gasQuote, readQuote, statusPayload } from './quote.mjs'

const ctx = connect()
const { dep, pub, wallet, account, abi, read } = ctx
const S = dep.settlement
const me = account.address

// Refuse mismatched configuration before reading user state or sending any transaction.
async function validateDeployment() {
  if (await pub.getChainId() !== Number(dep.chainId)) fail('RPC network differs from the deployment; select the correct RPC_URL and deployment')
  const [vault, token0, token1, depositToken] = await Promise.all(['vault', 'token0', 'token1', 'depositToken'].map((name) => read(S, name)))
  for (const [name, actual] of Object.entries({ vault, token0, token1, depositToken })) {
    if (dep[name] != null && (typeof dep[name] !== 'string' || dep[name].toLowerCase() !== actual.toLowerCase())) fail(`deployment ${name} differs from the settlement; select the correct deployment`)
  }
  if (BigInt(token0) === 0n || BigInt(token1) === 0n || token0.toLowerCase() === token1.toLowerCase()) fail('settlement token pair is not initialized')
}

async function tokens() {
  const [t0, t1, depositToken] = await Promise.all([read(S, 'token0'), read(S, 'token1'), read(S, 'depositToken')])
  const meta = async (address) => {
    let raw = null
    try { raw = await read(address, 'symbol', [], abi.erc20) } catch { raw = null }
    const decimals = await read(address, 'decimals', [], abi.erc20)
    return { address, symbol: cleanSymbol(raw, address), decimals }
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
  const nonce = await pub.getTransactionCount({ address: me, blockTag: 'pending' })
  const hash = await wallet.writeContract({ ...request, nonce })
  const outcome = await confirmTx(pub, hash, { from: me, nonce, confirmations: confirmationsFor(dep) })
  if (outcome.status !== 'confirmed') fail(describeOutcome(functionName, outcome))
  return outcome.receipt
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

async function preparationState(b, now) {
  if (!dep.admission?.manifestSha256) return null
  let prepared
  try { prepared = loadState(dep, me).preparation }
  catch { return 'local state unreadable; restore a backup' }
  if (!prepared) return 'none'
  try {
    await checkAdmissionNetwork()
    const preparedBatch = BigInt(prepared.batch)
    const round = await read(S, 'targetRound', [preparedBatch])
    validatePreparation(prepared, { dep, owner: me, batch: preparedBatch, round })
    const closes = await read(S, 'commitsClose', [preparedBatch])
    const state = preparedBatch < b || now >= closes ? 'expired' : 'prepared'
    return `${state} for batch ${preparedBatch}`
  } catch { return 'invalid for this account, network or deployment' }
}

const hasSettlement = (name) => abi.settlement.some((item) => item.type === 'function' && item.name === name)

async function quoteFor(batchId, t, block = null) {
  const sample = block ?? await pub.getBlock()
  const quote = await readQuote({
    read: (name, args = []) => read(S, name, args),
    has: hasSettlement,
    batchId,
    decimals0: t.token0.decimals,
    decimals1: t.token1.decimals,
    block: sample,
  })
  return { block: sample, quote }
}

async function dryRunReport(t, order, current, enforced) {
  const { block, quote } = await quoteFor(current, t)
  if (enforced) return { quote, gas: gasQuote({ block, reason: 'preview does not build an admission proof' }) }
  try {
    const salt = newSalt()
    const hash = orderHash(dep.chainId, S, current, order, salt)
    const round = await read(S, 'targetRound', [current])
    const ciphertext = await encrypt(round, order, salt)
    const units = await pub.estimateContractGas({
      account, address: S, abi: abi.settlement, functionName: 'commit', args: [current, hash, ciphertext],
    })
    return { quote, gas: gasQuote({ units, gasPrice: await pub.getGasPrice(), block }) }
  } catch (error) {
    return { quote, gas: gasQuote({ block, reason: error.shortMessage || error.message }) }
  }
}

async function status(json = false) {
  const t = await tokens()
  const { open, rows } = await vaultView(t)
  const [b, block] = await Promise.all([read(S, 'currentBatch'), pub.getBlock()])
  const now = block.timestamp
  const times = await schedule(b)
  const preparation = await preparationState(b, now)
  if (json) {
    const { quote } = await quoteFor(b, t, block)
    console.log(JSON.stringify(statusPayload({
      account: me, chainId: dep.chainId, token0: t.token0, token1: t.token1, rows,
      openCommitments: open, batchId: b, now, deadlines: times, preparation, quote,
    })))
    return
  }
  console.log(`account ${me}`)
  console.log(`network ${dep.chainId}`)
  console.log(`pair ${t.token0.symbol} / ${t.token1.symbol}`)
  for (const r of rows) {
    console.log(`  ${r.tok.symbol.padEnd(6)} wallet ${fmt(r.tok, r.wallet)} | available ${fmt(r.tok, r.available)} | reserved ${fmt(r.tok, r.reserved)} | withdrawable ${fmt(r.tok, r.withdrawable)}`)
  }
  console.log(`  open commitments: ${open}${open ? ' (withdrawals blocked until each is revealed and settled, slashed, released or expired)' : ''}`)
  console.log(`batch ${b} (chain time ${now})`)
  for (const d of times) console.log(`  ${String(d.at - now).padStart(5)}s  ${d.what}`)
  if (preparation) console.log(`preparation: ${preparation}`)
}

// Runtime of TransferProbe, with its code installed on the holder for one eth_call.
// `transfer` then runs as that holder, so the vault's balance change is visible before any transaction.
const TRANSFER_PROBE = '0x608060405234801561000f575f80fd5b5060043610610029575f3560e01c80631ead4b791461002d575b5f80fd5b61004760048036038101906100429190610273565b61005d565b60405161005491906102d2565b60405180910390f35b5f808473ffffffffffffffffffffffffffffffffffffffff166370a08231856040518263ffffffff1660e01b815260040161009891906102fa565b602060405180830381865afa1580156100b3573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906100d79190610327565b90508473ffffffffffffffffffffffffffffffffffffffff1663a9059cbb85856040518363ffffffff1660e01b8152600401610114929190610352565b6020604051808303815f875af1158015610130573d5f803e3d5ffd5b505050506040513d601f19601f8201168201806040525081019061015491906103ae565b50808573ffffffffffffffffffffffffffffffffffffffff166370a08231866040518263ffffffff1660e01b815260040161018f91906102fa565b602060405180830381865afa1580156101aa573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906101ce9190610327565b6101d89190610406565b9150509392505050565b5f80fd5b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f61020f826101e6565b9050919050565b61021f81610205565b8114610229575f80fd5b50565b5f8135905061023a81610216565b92915050565b5f819050919050565b61025281610240565b811461025c575f80fd5b50565b5f8135905061026d81610249565b92915050565b5f805f6060848603121561028a576102896101e2565b5b5f6102978682870161022c565b93505060206102a88682870161022c565b92505060406102b98682870161025f565b9150509250925092565b6102cc81610240565b82525050565b5f6020820190506102e55f8301846102c3565b92915050565b6102f481610205565b82525050565b5f60208201905061030d5f8301846102eb565b92915050565b5f8151905061032181610249565b92915050565b5f6020828403121561033c5761033b6101e2565b5b5f61034984828501610313565b91505092915050565b5f6040820190506103655f8301856102eb565b61037260208301846102c3565b9392505050565b5f8115159050919050565b61038d81610379565b8114610397575f80fd5b50565b5f815190506103a881610384565b92915050565b5f602082840312156103c3576103c26101e2565b5b5f6103d08482850161039a565b91505092915050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b5f61041082610240565b915061041b83610240565b9250828203905081811115610433576104326103d9565b5b9291505056fea26469706673582212206c04e8af46716722ea46b1cff64bc7ac999432c34f9c7d5bdf799135dbc23bac64736f6c634300081a0033'

async function arrivedOnTransfer(token, amount) {
  const data = encodeFunctionData({
    abi: [{ type: 'function', name: 'arrived', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'uint256' }] }],
    functionName: 'arrived',
    args: [token, dep.vault, amount],
  })
  const { data: out } = await pub.call({ account: me, to: me, data, stateOverride: [{ address: me, code: TRANSFER_PROBE }] })
  if (!out || out === '0x') throw new Error('transfer probe returned nothing')
  return BigInt(out)
}

async function deposit(name, amount) {
  const t = await tokens()
  const tok = pick(t, name)
  const value = parseUnits(amount, tok.decimals)
  let arrived
  try { arrived = await arrivedOnTransfer(tok.address, value) }
  catch (error) { fail(`could not check how much this token delivers on transfer (${error.shortMessage || error.message})`) }
  if (arrived < value) fail(`this token takes a fee or rebases on transfer; Blindfold doesn't support it (arrived ${fmt(tok, arrived)})`)
  const allowance = await read(tok.address, 'allowance', [me, dep.vault], abi.erc20)
  if (allowance < value) await send(tok.address, abi.erc20, 'approve', [dep.vault, value])
  await send(dep.vault, abi.vault, 'deposit', [tok.address, value])
  console.log(`deposited ${fmt(tok, value)}`)
}

async function checkAdmissionNetwork() {
  if (await pub.getChainId() !== Number(dep.chainId)) fail('RPC network differs from the deployment; select the correct RPC_URL and deployment')
}

async function prepare(batchText) {
  if (!/^\d+$/.test(batchText ?? '')) fail('usage: prepare-admission <batch-id>')
  await checkAdmissionNetwork()
  if (!await admissionRequired()) fail('this deployment does not use proof-enforced admission')
  const batch = BigInt(batchText)
  const current = await read(S, 'currentBatch')
  if (batch < current || batch >= 1n << 64n) fail('select an explicit current or future batch')
  const round = await read(S, 'targetRound', [batch])
  console.log(`preparing locally for batch ${batch}, round ${round}…`)
  const preparation = await prepareAdmission({ dep, owner: me, batch, round })
  if ((await pub.getBlock()).timestamp >= await read(S, 'commitsClose', [batch])) fail('preparation completed after the batch closed; select a later batch')
  await checkAdmissionNetwork()
  const state = loadState(dep, me)
  state.preparation = preparation
  writeState(dep, me, state)
  console.log(`prepared batch ${batch} in ${preparation.elapsedSeconds.toFixed(2)}s; private preparation saved locally`)
}

async function commit(side, amountIn, minOut, dryRun, vaultOnly = false, bothFunded = false, json = false) {
  if (side !== 'sell' && side !== 'buy') fail('side must be sell or buy')
  const t = await tokens()
  const [tin, tout] = side === 'sell' ? [t.token0, t.token1] : [t.token1, t.token0]
  const order = { owner: me, zeroForOne: side === 'sell', amountIn: parseUnits(amountIn, tin.decimals), minAmountOut: parseUnits(minOut, tout.decimals) }
  const has = (n) => abi.settlement.some((f) => f.type === 'function' && f.name === n)
  const [current, depositAmount, maxCommits, now] = await Promise.all([
    read(S, 'currentBatch'), read(S, 'depositAmount'), read(S, 'MAX_COMMITS'), pub.getBlock().then((x) => x.timestamp)])
  const fee = has('commitFee') ? await read(S, 'commitFee') : 0n // REVIEW R3: not every deployment charges one yet
  const [commitsClose, commits] = await Promise.all([read(S, 'commitsClose', [current]), read(S, 'commitIdsOf', [current])])
  const per = async (f) => Object.fromEntries(await Promise.all(Object.keys(t.byAddress).map(async (a) => [a, await f(a)])))
  const enforced = await admissionRequired()
  let funding, minLead = 3n
  if (enforced) {
    await checkAdmissionNetwork()
    if (!dep.admission?.manifestSha256) fail('this deployment requires admission; its deployment file must include the parameter manifest')
    const state = loadState(dep, me)
    funding = reconcileFunding(dep, me, state.admission, await fundingOnchain(), now)
    if (state.preparation) validatePreparation(state.preparation, { dep, owner: me, batch: current, round: await read(S, 'targetRound', [current]) })
    minLead = admissionLead(!!state.preparation)
    state.admission = funding
    if (!dryRun) writeState(dep, me, state)
  }
  const check = preflight({
    cumulative: enforced ? { [t.token0.address]: funding.totals[0], [t.token1.address]: funding.totals[1] } : {},
    minLead,
    order, tokenIn: tin.address, depositToken: t.depositToken, depositAmount, fee,
    free: await per((a) => read(dep.vault, 'freeBalance', [me, a])),
    wallet: await per((a) => read(a, 'balanceOf', [me], abi.erc20)),
    allowance: await per((a) => read(a, 'allowance', [me, dep.vault], abi.erc20)),
    batch: { id: current, current, commitsClose, now, commits: BigInt(commits.length), maxCommits },
    openBatches: [...new Set([...(await myCommitments()).values()].filter(isOpen).map((c) => c.batchId))],
  })
  const dt = t.byAddress[t.depositToken]
  console.log(`order: ${side} ${fmt(tin, order.amountIn)} for at least ${fmt(tout, order.minAmountOut)} in batch ${current}`)
  console.log(`costs: deposit ${fmt(dt, depositAmount)} (returned minus the revealer's bounty when revealed), fee ${fmt(dt, fee)}`)
  for (const f of check.funding) {
    const tok = t.byAddress[f.token]
    console.log(`funding ${tok.symbol}: need ${fmt(tok, f.need)}, vault free ${fmt(tok, f.free)}${f.shortfall ? `, deposit ${fmt(tok, f.shortfall)} first${f.approve ? ' (needs approval)' : ''}` : ''}`)
  }
  for (const d of await schedule(current)) console.log(`  ${String(d.at - now).padStart(5)}s  ${d.what}`)
  if (!enforced) console.log(`keep ${fmt(tin, order.amountIn)} free in the vault until the reveal, or the order is closed as unfunded and the deposit lost`)
  if (!check.ok) fail(`preflight failed:\n  ${check.problems.join('\n  ')}`)
  if (bothFunded) {
    const balances = await Promise.all([t.token0, t.token1].map((token) => read(dep.vault, 'balanceOf', [me, token.address])))
    if (balances.some((balance) => balance === 0n)) fail('fund both tokens in the vault before trading')
  }
  if (vaultOnly && check.funding.some((f) => f.shortfall > 0n)) fail('fund the required vault balances before trading; automatic deposits are disabled')
  if (dryRun) {
    if (json) console.log(JSON.stringify(await dryRunReport(t, order, current, enforced)))
    return console.log('dry run: nothing sent')
  }
  for (const f of check.funding) {
    if (!f.shortfall) continue
    if (f.approve) await send(f.token, abi.erc20, 'approve', [dep.vault, f.shortfall])
    await send(dep.vault, abi.vault, 'deposit', [f.token, f.shortfall])
  }
  const salt = newSalt()
  const hash = orderHash(dep.chainId, S, current, order, salt)
  const round = await read(S, 'targetRound', [current])
  if (enforced) {
    const budgets = await Promise.all([t.token0, t.token1].map(async (tok) => {
      const free = await read(dep.vault, 'freeBalance', [me, tok.address])
      return free - (tok.address.toLowerCase() === t.depositToken.toLowerCase() ? depositAmount + fee : 0n)
    }))
    const prepared = consumePreparation(loadState(dep, me), { dep, owner: me, batch: current, round }, (state) => writeState(dep, me, state))
    console.log(prepared ? 'generating the online admission proof locally…' : 'generating both admission proofs locally…')
    const result = await proveAdmission({ dep, owner: me, batch: current, round, funding, budgets, order, salt, prepared })
    console.log(`local proving completed in ${result.timings.elapsedSeconds.toFixed(2)}s`)
    await checkAdmissionNetwork()
    const latest = (await pub.getBlock()).timestamp
    if (latest >= commitsClose) fail('proof completed after this batch closed; nothing submitted, start a new order in the current batch')
    reconcileFunding(dep, me, funding, await fundingOnchain(), latest)
    const state = loadState(dep, me)
    state.commitments.push({ id: null, batchId: current, round, hash, order, salt })
    state.admission = { ...funding, pending: { ...result, batch: current, closes: commitsClose } }
    writeState(dep, me, state)
    return resumeAdmission()
  }
  const ciphertext = await encrypt(round, order, salt)
  saveCommitment(dep, me, { id: null, batchId: current, round, hash, order, salt }) // before sending: never lose the salt
  const receipt = await send(S, abi.settlement, 'commit', [current, hash, ciphertext])
  const [ev] = parseEventLogs({ abi: abi.settlement, logs: receipt.logs, eventName: 'Committed' })
  saveCommitment(dep, me, { id: ev.args.commitId, hash, tx: receipt.transactionHash })
  console.log(`committed #${ev.args.commitId} to round ${round} in ${receipt.transactionHash}`)
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
    const nonce = await pub.getTransactionCount({ address: me, blockTag: 'pending' })
    tx = await wallet.writeContract({ ...request, nonce })
    Object.assign(state.admission.pending, { tx, nonce })
    writeState(dep, me, state)
  }
  const outcome = await confirmTx(pub, tx, { from: me, nonce: pending.nonce ?? state.admission.pending.nonce, confirmations: confirmationsFor(dep) })
  if (outcome.status === 'dropped') {
    // Nothing reached the chain: forget the hash so the next resume-admission sends the same proof again.
    delete state.admission.pending.tx; delete state.admission.pending.nonce
    writeState(dep, me, state)
    fail(`admission ${tx} was dropped before inclusion; run resume-admission again to resend it`)
  }
  if (outcome.status === 'replaced') fail(`${describeOutcome('admission', outcome)}; pending state retained, run resume-admission to reconcile`)
  if (outcome.status !== 'confirmed') fail(`admission reverted in ${tx}; pending state retained until its batch closes`)
  const receipt = outcome.receipt
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

async function trackAll(asJson) {
  const t = await tokens()
  const mine = await myCommitments()
  if (!asJson) {
    if (!mine.size) return console.log('no commitments')
    for (const c of mine.values()) {
      const o = c.order
      const what = o ? `${o.zeroForOne ? 'sell' : 'buy'} ${o.amountIn}` : 'sealed'
      const fill = fillDescription(c, (token, amount) => fmt(t[token], amount))
      console.log(`#${c.id} batch ${c.batchId}: ${c.state} (${what})${fill}`)
    }
    return
  }
  const has = (n) => abi.settlement.some((f) => f.type === 'function' && f.name === n)
  const [depositAmount, bountyBps, now, enforced] = await Promise.all([
    read(S, 'depositAmount'),
    has('bountyBps') ? read(S, 'bountyBps') : 0n,
    pub.getBlock().then((x) => x.timestamp),
    admissionRequired(),
  ])
  const fee = has('commitFee') ? await read(S, 'commitFee') : 0n
  const dt = t.byAddress[t.depositToken]
  const policy = {
    depositToken: dt.symbol,
    depositAmount: formatUnits(depositAmount, dt.decimals),
    commitFee: formatUnits(fee, dt.decimals),
    bountyBps: Number(bountyBps),
    admissionRequired: Boolean(enforced),
  }
  const open = [...mine.values()]
  const sched = new Map()
  for (const b of new Set(open.map((c) => c.batchId))) {
    const [revealOpens, revealCloses, settleCloses] = await Promise.all(['revealOpens', 'revealCloses', 'settleCloses'].map((f) => read(S, f, [b])))
    sched.set(b, { revealOpens, revealCloses, settleCloses })
  }
  const kept = new Map(loadState(dep, me).commitments.map((x) => [x.hash, x]))
  const { ordersPayload } = await import('./orders.mjs')
  const payload = ordersPayload({
    policy,
    now: Number(now),
    commitments: [...mine.values()],
    tokens: t,
    saved: kept,
    schedules: sched,
  })
  console.log(JSON.stringify(payload))
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

async function blockers(asJson) {
  const { now, steps } = await exitSteps()
  if (asJson) {
    const { blockersPayload } = await import('./orders.mjs')
    return console.log(JSON.stringify(blockersPayload({ now, steps })))
  }
  if (!steps.length) return console.log('nothing blocks withdrawal')
  for (const s of steps) console.log(describe(s, now))
}

/** Guided exit: one transaction per step, in order; reports what still blocks withdrawal. */
async function cleanup(dryRun, asJson) {
  const { now, kept, steps } = await exitSteps()
  const expired = new Set()
  const done = []
  for (const s of steps) {
    if (!asJson) console.log(describe(s, now))
    if (s.action === 'wait') continue
    const { id, batchId } = s.c
    let tx = null
    if (!dryRun) {
      if (s.action === 'reveal') {
        const receipt = await send(S, abi.settlement, 'reveal', [id, kept.get(s.c.hash).order, kept.get(s.c.hash).salt])
        tx = receipt.transactionHash
      }
      if (s.action === 'slash' || s.action === 'release') {
        const receipt = await send(S, abi.settlement, 'slashUnrevealed', [id])
        tx = receipt.transactionHash
      }
      if (s.action === 'expire' && !expired.has(batchId)) {
        expired.add(batchId)
        const receipt = await send(S, abi.settlement, 'expire', [batchId])
        tx = receipt.transactionHash
      }
    }
    done.push({ id: String(id), action: s.action, tx })
  }
  const open = await read(dep.vault, 'openCommitments', [me])
  if (asJson) {
    const { cleanupPayload } = await import('./orders.mjs')
    return console.log(JSON.stringify(cleanupPayload({ dryRun, done, stillBlocking: open })))
  }
  if (dryRun) return console.log('dry run: nothing sent')
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

const [cmd, ...args] = process.argv.slice(2)
const commands = {
  status: () => status(args.includes('--json')),
  deposit: () => deposit(args[0], args[1]),
  commit: () => commit(args[0], args[1], args[2], args.includes('--dry-run'), args.includes('--vault-only'), args.includes('--both-funded'), args.includes('--json')),
  track: () => trackAll(args.includes('--json')),
  'prepare-admission': () => prepare(args[0]),
  'resume-admission': () => resumeAdmission(),
  blockers: () => blockers(args.includes('--json')),
  cleanup: () => cleanup(args.includes('--dry-run'), args.includes('--json')),
  withdraw: () => withdraw(args[0], args[1] ?? 'all'),
  'export-state': () => exportCmd(args[0]),
  'import-state': () => importCmd(args[0]),
}
if (!commands[cmd]) fail(`usage: npm start -- <${Object.keys(commands).join('|')}> ...`)
try {
  const mutates = ['prepare-admission', 'commit', 'resume-admission', 'import-state', 'cleanup', 'withdraw', 'deposit'].includes(cmd)
  await validateDeployment()
  await (mutates ? withStateLock(dep, me, commands[cmd]) : commands[cmd]())
}
catch (e) { console.error(`client: ${e.shortMessage ?? e.message}`); process.exitCode = 1 }
