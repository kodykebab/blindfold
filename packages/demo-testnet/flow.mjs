// Scenario plumbing shared by traffic.mjs and scenarios.mjs: the client CLI as any demo wallet, one keeper or solver
// pass, waits on chain time, and the settlement's schedule. Every wallet's role comes from DEMO_MNEMONIC (common.mjs).
import { execFile } from 'node:child_process'
import { BLINDFOLD_FILE, MNEMONIC, RPC_URL, artifact, here, pub, readJson } from './common.mjs'

export const SETTLEMENT = artifact('BlindfoldSettlement.sol', 'BlindfoldSettlement')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// Role keys always come from the mnemonic: a PRIVATE_KEY, KEEPER_KEY or SOLVER_KEY left in the shell would sign as someone else.
function run(file, args, env) {
  const base = { ...process.env, RPC_URL, DEPLOYMENTS: BLINDFOLD_FILE, MNEMONIC }
  for (const k of ['PRIVATE_KEY', 'KEEPER_KEY', 'SOLVER_KEY']) delete base[k]
  return new Promise((resolve) => execFile(process.execPath, [file, ...args], { env: { ...base, ...env }, timeout: 600_000 },
    (e, out, err) => resolve({ code: e ? e.code ?? 1 : 0, out: out.trim(), err: err.trim() })))
}

/** The client CLI as wallet `index`, with its private state and encrypted backups under .state/. */
export const cli = (index, args, env = {}) => run(here('../client/cli.mjs'), args, {
  CLIENT_ACCOUNT_INDEX: String(index), CLIENT_STATE: here('.state/client'), CLIENT_BACKUP_DIR: here('.state/backups'), ...env,
})
/** One keeper pass (account 1): reveal, slash, expire, and settle what the solver left past its grace period. */
export async function keeperOnce(env = {}) {
  const r = await run(here('../keeper/keeper.mjs'), ['--once'], env)
  const line = r.out.split('\n').reverse().find((l) => l.startsWith('{'))
  return { ...r, st: line ? JSON.parse(line) : null }
}
/** One solver pass (account 2): settle every batch whose settle window is open. */
export const solverOnce = (env = {}) => run(here('../solver/solver.mjs'), ['--once'], env)

export const deployment = () => readJson(BLINDFOLD_FILE, 'Run `npm run deploy` first.')
export const read = (functionName, args = []) => pub.readContract({ address: deployment().settlement, abi: SETTLEMENT.abi, functionName, args })
export const chainNow = async () => (await pub.getBlock({ blockTag: 'latest' })).timestamp

/** Wait until chain time reaches `ts`. Chain time, not wall time: commits, reveals and settles are judged by it. */
export async function waitUntil(ts, why) {
  let now = await chainNow()
  if (now >= ts) return
  log(`waiting ${ts - now}s for ${why}`)
  while (now < ts) {
    await sleep(Number(ts - now > 5n ? 5n : ts - now) * 1000)
    now = await chainNow()
  }
}

/** The open batch, once it has at least `minLeft` seconds of commits left (else the next one). */
export async function openBatch(minLeft = 25n) {
  for (;;) {
    const b = await read('currentBatch')
    const close = await read('commitsClose', [b])
    if (close - await chainNow() >= minLeft) return b
    await waitUntil(close + 1n, `batch ${b} to close; the next one takes the orders`)
  }
}

/** Keeper passes from the drand round until `expected` reveals have landed or the reveal window ends. */
export async function revealBatch(b, expected, env = {}) {
  await waitUntil(await read('revealOpens', [b]), `batch ${b}'s drand round`)
  const closes = await read('revealCloses', [b])
  let revealed = 0
  while (revealed < expected && await chainNow() < closes) {
    const { st, err } = await keeperOnce(env)
    revealed += st?.revealed ?? 0
    if (st?.errors?.length || (!st && err)) log(`keeper: ${st?.errors?.join('; ') ?? err}`)
    if (revealed < expected) await sleep(3000)
  }
  log(`keeper revealed ${revealed} order(s) in batch ${b}`)
  if (revealed !== expected) throw new Error(`batch ${b}: expected ${expected} reveals, got ${revealed}`)
  return revealed
}

/** One solver pass once batch `b`'s settle window opens; returns the solver's own summary line. */
export async function settleBatch(b, env = {}) {
  await waitUntil(await read('revealCloses', [b]), `batch ${b}'s settle window`)
  const r = await solverOnce(env)
  const line = [r.out, r.err].join('\n').split('\n').find((l) => l.startsWith(`settled batch ${b}:`))
  if (!line) throw new Error(`solver did not settle batch ${b}: ${r.err || r.out || 'nothing to do'}`)
  log(line)
  return line
}
