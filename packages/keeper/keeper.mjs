// Blindfold keeper: reveals committed orders once their drand round is out, slashes what nobody revealed, settles batches
// the solver missed (by running the solver itself) and expires batches nobody settled, so no user stays locked. Every
// action is permissionless; this service just does them on time.
//   npm start            # poll every POLL_MS
//   npm start -- --once  # do the work due now, print one status line, exit (non-zero on an unexpected error)
// Discovery reads Committed events from the settlement; contract state is the only source of truth (no Arkiv needed).
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, defineChain, http, toHex } from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
// shortcut: reuses the client's helpers in place, so packages/client must be installed too; publish them as a package if a third consumer appears
import { TEST_MNEMONIC, decrypt, drandClient, loadAbi, loadDeployment, orderHash } from '../client/lib.mjs'
import { canSpend, due, lostRace, opened, settledBatches } from './work.mjs'

const E = process.env
const once = process.argv.includes('--once')
const POLL_MS = Number(E.POLL_MS || 3000)
const BUDGET = E.KEEPER_BUDGET_WEI != null ? BigInt(E.KEEPER_BUDGET_WEI) : null // null = unlimited
const MIN_BALANCE = BigInt(E.KEEPER_MIN_BALANCE_WEI ?? 10n ** 15n)
const STATUS = E.KEEPER_STATUS // optional file the monitor reads; also carries the spend across restarts
// anvil account 1 is the keeper (PLAN.md seams); public test key, local only
const account = E.KEEPER_KEY ? privateKeyToAccount(E.KEEPER_KEY) : mnemonicToAccount(E.MNEMONIC || TEST_MNEMONIC, { addressIndex: Number(E.KEEPER_INDEX ?? 1) })
// Fallback settlement: after this many seconds past a batch's reveal deadline, settle it if no solver has.
// KEEPER_SETTLE_GRACE_S=off disables it. The default leaves the solver one block or so to go first.
const SETTLE_GRACE = (E.KEEPER_SETTLE_GRACE_S ?? '15') === 'off' ? null : Number(E.KEEPER_SETTLE_GRACE_S ?? 15)
if (SETTLE_GRACE !== null && !(Number.isInteger(SETTLE_GRACE) && SETTLE_GRACE >= 0)) throw new Error('KEEPER_SETTLE_GRACE_S must be a non-negative integer or off')
const SOLVER = E.KEEPER_SOLVER || fileURLToPath(new URL('../solver/solver.mjs', import.meta.url))
const solverKey = E.KEEPER_KEY ?? toHex(account.getHdKey().privateKey)

const dep = loadDeployment()
const abi = loadAbi('BlindfoldSettlement')
const S = dep.settlement
const rpc = E.RPC_URL || 'http://127.0.0.1:8545'
const chain = defineChain({ id: dep.chainId, name: 'blindfold', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
const transport = http(rpc, { timeout: 15_000, retryCount: 0 })
const pub = createPublicClient({ chain, transport, pollingInterval: 100 })
const wallet = createWalletClient({ account, chain, transport })
const read = (functionName, args = []) => pub.readContract({ address: S, abi, functionName, args })
const drand = drandClient()

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x))
let spent = STATUS && existsSync(STATUS) ? BigInt(JSON.parse(readFileSync(STATUS, 'utf8')).spentWei ?? 0) : 0n

async function cycle() {
  const st = { keeper: account.address, revealed: 0, slashed: 0, settled: 0, expired: 0, lostRace: 0, waitingBeacon: [], unopenable: [], skipped: [], errors: [], gas: {} }
  const [block, balance] = await Promise.all([pub.getBlock(), pub.getBalance({ address: account.address })])
  const now = block.timestamp
  Object.assign(st, { block: block.number, chainTime: now })

  const logs = await pub.getContractEvents({ address: S, abi, eventName: 'Committed', fromBlock: BigInt(dep.deployBlock ?? 0) })
  const commitments = await Promise.all(logs.map(async ({ args: a }) => {
    const [, , status] = await read('commitments', [a.commitId])
    return { id: a.commitId, batchId: a.batchId, committer: a.committer, hash: a.hash, round: a.round, ciphertext: a.ciphertext, status: Number(status) }
  }))
  const batches = new Map()
  for (const b of new Set(commitments.map((c) => c.batchId))) {
    const [revealOpens, revealCloses, settleCloses, finalized, ids] = await Promise.all([
      read('revealOpens', [b]), read('revealCloses', [b]), read('settleCloses', [b]), read('finalized', [b]), read('orderIdsOf', [b])])
    batches.set(b, { revealOpens, revealCloses, settleCloses, finalized, orders: BigInt(ids.length) })
  }
  const work = due(commitments, batches, now, SETTLE_GRACE)
  st.due = { reveal: work.reveal.length, slash: work.slash.length, settle: work.settle.length, expire: work.expire.length }

  /** Simulate right before sending, so a reveal someone else already landed costs nothing (REVIEW S8). */
  async function send(kind, functionName, args) {
    const gate = canSpend({ spent, budget: BUDGET, balance, minBalance: MIN_BALANCE })
    if (!gate.ok) return st.skipped.push({ kind, args: args.slice(0, 1), why: gate.why })
    try {
      const { request } = await pub.simulateContract({ account, address: S, abi, functionName, args })
      const receipt = await pub.waitForTransactionReceipt({ hash: await wallet.writeContract(request) })
      spent += receipt.gasUsed * receipt.effectiveGasPrice
      ;(st.gas[kind] ??= []).push(receipt.gasUsed)
      if (receipt.status !== 'success') {
        // simulated fine, then lost the race inside the same block
        const done = kind === 'expire' ? await read('finalized', [args[0]]) : Number((await read('commitments', [args[0]]))[2]) !== 1
        if (done) st.lostRace++
        else st.errors.push(`${kind} ${args[0]} reverted in ${receipt.transactionHash}`)
        return
      }
      st[{ reveal: 'revealed', slash: 'slashed', expire: 'expired' }[kind]]++
    } catch (e) {
      if (lostRace(e)) st.lostRace++
      else st.errors.push(`${kind} ${args[0]}: ${e.shortMessage ?? e.message}`)
    }
  }

  for (const c of work.reveal) {
    try {
      await drand.get(Number(c.round))
    } catch {
      st.waitingBeacon.push(c.id) // round not out (or drand unreachable): retry next cycle until the window closes
      continue
    }
    let payload
    try {
      payload = await decrypt(c.ciphertext, drand)
    } catch {
      st.unopenable.push({ id: c.id, why: 'ciphertext does not decrypt' }) // garbage: slashed after the window
      continue
    }
    const o = opened(c, payload, { chainId: dep.chainId, settlement: S, orderHash })
    if (!o.ok) st.unopenable.push({ id: c.id, why: o.why })
    else await send('reveal', 'reveal', o.args)
  }
  for (const c of work.slash) await send('slash', 'slashUnrevealed', [c.id])
  if (work.settle.length) await settleMissed(work.settle, st, balance)
  for (const b of work.expire) await send('expire', 'expire', [b])

  Object.assign(st, { at: new Date().toISOString(), spentWei: spent, budgetWei: BUDGET, balanceWei: await pub.getBalance({ address: account.address }) })
  console.log(json(st))
  if (STATUS) writeFileSync(STATUS, json(st))
  return st
}

/**
 * Run the solver once with the keeper's key, so the keeper settles with the solver's own search and checks instead of a
 * copy of them. The solver settles every batch in its window; a batch it finds already finalized is skipped.
 */
async function settleMissed(batchIds, st, balance) {
  const gate = canSpend({ spent, budget: BUDGET, balance, minBalance: MIN_BALANCE })
  if (!gate.ok) return st.skipped.push({ kind: 'settle', args: batchIds, why: gate.why })
  const before = await pub.getBalance({ address: account.address })
  const { code, output } = await new Promise((resolve) => {
    execFile(process.execPath, [SOLVER, '--once'], { env: { ...E, RPC_URL: rpc, SOLVER_KEY: solverKey }, timeout: 120_000 },
      (e, stdout, stderr) => resolve({ code: e ? (e.code ?? 1) : 0, output: `${stdout}${stderr}` }))
  })
  const after = await pub.getBalance({ address: account.address })
  if (after < before) spent += before - after
  const settled = settledBatches(output)
  st.settled += settled.length
  for (const b of batchIds) {
    if (settled.includes(b)) continue
    if (await read('finalized', [b])) st.lostRace++ // the solver (or another keeper) settled it first
    else if (code !== 0) st.errors.push(`settle ${b}: ${output.trim().split('\n').pop()}`)
  }
}

if (once) {
  const st = await cycle().catch((e) => ({ errors: [e.shortMessage ?? e.message] }))
  if (st.errors.length) console.error(`keeper: ${st.errors.join('; ')}`)
  process.exit(st.errors.length ? 1 : 0)
}
for (;;) {
  await cycle().catch((e) => console.error(`keeper: ${e.shortMessage ?? e.message}`)) // RPC hiccup: try again next poll
  await new Promise((r) => setTimeout(r, POLL_MS))
}
