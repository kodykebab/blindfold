// Blindfold client CLI: one workflow from funding to withdrawal.
//   npm start -- status                          balances (wallet / available / reserved / withdrawable) and the open batch
//   npm start -- deposit <token0|token1> <amount>
//   npm start -- commit <sell|buy> <amountIn> <minAmountOut> [--dry-run]   preflight, encrypt, commit
//   npm start -- track                           every commitment of this account and what happened to it
//   npm start -- blockers                        which commitments block withdrawal and what clears each
//   npm start -- cleanup [--dry-run]             reveal own saved orders, slash unrevealed, expire unsettled batches
//   npm start -- withdraw <token0|token1> <amount|all>
// sell = token0 in, token1 out; buy = token1 in, token0 out. Amounts are decimal token units.
import { formatUnits, parseEventLogs, parseUnits } from 'viem'
import { connect, encrypt, newSalt, orderHash } from './lib.mjs'
import { balances, deadlines, exitPlan, isOpen, preflight, track } from './flow.mjs'
import { loadState, saveCommitment } from './state.mjs'

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
  console.error(`client: ${msg}`)
  process.exit(1)
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

async function schedule(b) {
  const names = ['commitsClose', 'revealOpens', 'revealCloses', 'settleCloses']
  const v = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await read(S, n, [b])])))
  return deadlines(v)
}

async function status() {
  const t = await tokens()
  const { open, rows } = await vaultView(t)
  console.log(`account ${me}`)
  for (const r of rows) {
    console.log(`  ${r.tok.symbol.padEnd(6)} wallet ${fmt(r.tok, r.wallet)} | available ${fmt(r.tok, r.available)} | reserved ${fmt(r.tok, r.reserved)} | withdrawable ${fmt(r.tok, r.withdrawable)}`)
  }
  console.log(`  open commitments: ${open}${open ? ' (withdrawals blocked until each is revealed and settled, slashed or expired)' : ''}`)
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

async function commit(side, amountIn, minOut, dryRun) {
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
  const check = preflight({
    order, tokenIn: tin.address, depositToken: t.depositToken, depositAmount, fee,
    free: await per((a) => read(dep.vault, 'freeBalance', [me, a])),
    wallet: await per((a) => read(a, 'balanceOf', [me], abi.erc20)),
    allowance: await per((a) => read(a, 'allowance', [me, dep.vault], abi.erc20)),
    batch: { id: current, current, commitsClose, now, commits: BigInt(commits.length), maxCommits },
  })
  const dt = t.byAddress[t.depositToken]
  console.log(`order: ${side} ${fmt(tin, order.amountIn)} for at least ${fmt(tout, order.minAmountOut)} in batch ${current}`)
  console.log(`costs: deposit ${fmt(dt, depositAmount)} (returned minus the revealer's bounty when revealed), fee ${fmt(dt, fee)}`)
  for (const f of check.funding) {
    const tok = t.byAddress[f.token]
    console.log(`funding ${tok.symbol}: need ${fmt(tok, f.need)}, vault free ${fmt(tok, f.free)}${f.shortfall ? `, deposit ${fmt(tok, f.shortfall)} first${f.approve ? ' (needs approval)' : ''}` : ''}`)
  }
  for (const d of await schedule(current)) console.log(`  ${String(d.at - now).padStart(5)}s  ${d.what}`)
  console.log(`keep ${fmt(tin, order.amountIn)} free in the vault until the reveal, or the order is closed as unfunded and the deposit lost`)
  if (!check.ok) fail(`preflight failed:\n  ${check.problems.join('\n  ')}`)
  if (dryRun) return console.log('dry run: nothing sent')
  for (const f of check.funding) {
    if (!f.shortfall) continue
    if (f.approve) await send(f.token, abi.erc20, 'approve', [dep.vault, f.shortfall])
    await send(dep.vault, abi.vault, 'deposit', [f.token, f.shortfall])
  }
  const salt = newSalt()
  const hash = orderHash(dep.chainId, S, current, order, salt)
  const round = await read(S, 'targetRound', [current])
  const ciphertext = await encrypt(round, order, salt)
  saveCommitment(dep, me, { id: null, batchId: current, round, hash, order, salt }) // before sending: never lose the salt
  const receipt = await send(S, abi.settlement, 'commit', [current, hash, ciphertext])
  const [ev] = parseEventLogs({ abi: abi.settlement, logs: receipt.logs, eventName: 'Committed' })
  saveCommitment(dep, me, { id: ev.args.commitId, hash, tx: receipt.transactionHash })
  console.log(`committed #${ev.args.commitId} to round ${round} in ${receipt.transactionHash}`)
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
  return { now, kept, steps: exitPlan(open, { now, sched, saved: new Set(kept.keys()) }) }
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
    if (s.action === 'slash') await send(S, abi.settlement, 'slashUnrevealed', [id])
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

const [cmd, ...args] = process.argv.slice(2)
const commands = {
  status: () => status(),
  deposit: () => deposit(args[0], args[1]),
  commit: () => commit(args[0], args[1], args[2], args.includes('--dry-run')),
  track: () => trackAll(),
  blockers: () => blockers(),
  cleanup: () => cleanup(args.includes('--dry-run')),
  withdraw: () => withdraw(args[0], args[1] ?? 'all'),
}
if (!commands[cmd]) fail(`usage: npm start -- <${Object.keys(commands).join('|')}> ...`)
await commands[cmd]().catch((e) => fail(e.shortMessage ?? e.message))
