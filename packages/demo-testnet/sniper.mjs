// The demo sniper bot. It runs the "public mempool" the victims send through (MEMPOOL_URL, a JSON-RPC proxy in
// front of RPC_URL): every raw tx is shown to the bot before the chain gets it, as a public mempool would.
//   - A DemoRouter swap on the scene-1 pool: the bot sizes the largest front leg the victim's slippage allows,
//     sends it with a higher tip, lets the victim through, then sends the back leg selling everything it bought.
//   - A Blindfold commit: the order is a tlock ciphertext to a future drand round. The bot tries to decrypt it,
//     can't, sees no side, size or limit. It then tries to front-run the batch's sealed pool blind anyway; the
//     pool's hook lets only the settlement swap, so that reverts too.
// Run it in its own terminal for the whole demo:  npm run sniper
import { createServer } from 'node:http'
import { decodeErrorResult, decodeFunctionData, formatEther, parseAbi, parseTransaction, recoverTransactionAddress } from 'viem'
import { planSandwich } from '../demo-bots/lib.mjs'
import {
  BLINDFOLD_FILE, MEMPOOL_PORT, ROLES, RPC_URL, SANDWICH_FILE, account, artifact, eth, mined, poolIdOf, pub, same, wallet,
} from './common.mjs'
import { readFileSync, existsSync } from 'node:fs'

const ROUTER = artifact('DemoSwap.sol', 'DemoRouter')
const BOT = artifact('DemoSwap.sol', 'SandwichBot')
const SETTLEMENT = artifact('BlindfoldSettlement.sol', 'BlindfoldSettlement')
// v4 wraps a hook's revert in WrappedError(hook, selector, reason, details); name both layers
const ERRORS = [
  ...parseAbi(['error WrappedError(address target, bytes4 selector, bytes reason, bytes details)']), // CustomRevert library
  ...artifact('SealedPoolHook.sol', 'SealedPoolHook').abi.filter((x) => x.type === 'error'),
]
const why = (e) => {
  const d = e.walk?.((x) => x.data?.errorName)?.data
  if (d?.errorName !== 'WrappedError') return d?.errorName ?? e.shortMessage
  try {
    const inner = decodeErrorResult({ abi: ERRORS, data: d.args[2] })
    return `${inner.errorName}(${inner.args?.join(', ') ?? ''}) from the pool's hook`
  } catch {
    return "WrappedError from the pool's hook"
  }
}
const owner = account(ROLES.sniper)
const load = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null)
const RED = (s) => `\x1b[31m${s}\x1b[0m`
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`
const DIM = (s) => `\x1b[2m${s}\x1b[0m`
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await res.json()
  if (j.error) throw Object.assign(new Error(j.error.message), { rpc: j.error })
  return j.result
}

/** Plans the sandwich and sends the front leg; returns a function that sends the back leg, or null. */
async function front(demo, tx) {
  const { args } = decodeFunctionData({ abi: ROUTER.abi, data: tx.data })
  const [k, zeroForOne, victimIn, victimMin] = args
  if (poolIdOf(k) !== demo.poolId || !zeroForOne) return null // the bot holds ETH: it fronts ETH-in swaps only
  const [sqrtPriceX96, liquidity] = await pub.readContract({ address: demo.bot, abi: BOT.abi, functionName: 'poolState', args: [k] })
  const plan = planSandwich({
    sqrtPriceX96, liquidity, fee: k.fee, zeroForOne, victimIn, minOut: victimMin, maxFront: await pub.getBalance({ address: demo.bot }),
  })
  if (!plan) return log('bot: swap seen, slippage too tight to profit; skipping'), null
  log(RED(`bot: victim buys DEMO with ${eth(victimIn)}, accepts ≥ ${formatEther(victimMin)} DEMO. Front-running with ${eth(plan.frontIn)}`))
  const tip = (tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n)
  const maxFee = (tx.maxFeePerGas ?? tx.gasPrice ?? 0n)
  // outbid the victim's tip, not by a fixed gwei: testnet gas is ~0.001 gwei and a 1 gwei bump costs more than the sandwich earns
  const frontTip = tip * 2n + 1n
  const nonce = await pub.getTransactionCount({ address: owner.address, blockTag: 'pending' })
  const leg = (legArgs, i, t, f) => wallet(owner).writeContract({
    address: demo.bot, abi: BOT.abi, functionName: 'swap', args: legArgs, nonce: nonce + i, gas: 300_000n,
    maxPriorityFeePerGas: t, maxFeePerGas: f,
  })
  const before = await pub.getBalance({ address: demo.bot })
  const frontHash = await leg([k, zeroForOne, plan.frontIn], 0, frontTip, maxFee + frontTip)
  // the back leg goes out only after the victim's tx, so it can't land before it
  return async (victimHash) => {
    const backHash = await leg([k, !zeroForOne, 0n], 1, tip / 2n, maxFee)
    const [f, v, b] = await Promise.all([frontHash, victimHash, backHash].map((h) => mined(h).catch((e) => ({ error: e }))))
    if (f.error || v.error || b.error) return log(RED(`bot: a leg failed: ${(f.error ?? v.error ?? b.error).message}`))
    const profit = (await pub.getBalance({ address: demo.bot })) - before
    const gas = f.gasUsed * f.effectiveGasPrice + b.gasUsed * b.effectiveGasPrice
    log(RED(`SANDWICHED: front block ${f.blockNumber}#${f.transactionIndex}, victim ${v.blockNumber}#${v.transactionIndex}, back ${b.blockNumber}#${b.transactionIndex}; bot profit ${eth(profit)} (${eth(profit - gas)} after gas)`))
  }
}

async function sealed(tx, dep) {
  const { args } = decodeFunctionData({ abi: SETTLEMENT.abi, data: tx.data })
  const [batchId, , ciphertext] = args
  log(GREEN(`bot: Blindfold commit to batch ${batchId}: ${(ciphertext.length - 2) / 2} bytes of tlock ciphertext`))
  try {
    const { decrypt } = await import('../client/lib.mjs')
    const order = await decrypt(ciphertext)
    log(RED(`bot: decrypted early?! ${JSON.stringify(order, (_, v) => (typeof v === 'bigint' ? String(v) : v))}`))
  } catch (e) {
    log(GREEN(`bot: can't decrypt (${e.message.split('\n')[0]}). No side, size or limit price`))
  }
  if (!dep.poolKey) return
  try {
    await pub.simulateContract({ account: owner, address: load(SANDWICH_FILE).bot, abi: [...BOT.abi, ...ERRORS], functionName: 'swap', args: [dep.poolKey, true, 10n ** 18n] })
    log(RED('bot: the sealed pool accepted an outside swap?!'))
  } catch (e) {
    log(GREEN(`bot: tried to front-run the sealed pool blind: reverted ${why(e)}. Nothing to sandwich`))
  }
}

async function sendRaw(raw) {
  const tx = parseTransaction(raw)
  const from = await recoverTransactionAddress({ serializedTransaction: raw })
  const demo = load(SANDWICH_FILE)
  const dep = load(BLINDFOLD_FILE)
  let back = null
  try {
    if (demo && same(tx.to, demo.router)) back = await front(demo, tx)
    else if (dep && same(tx.to, dep.settlement) && decodeFunctionData({ abi: SETTLEMENT.abi, data: tx.data }).functionName === 'commit') await sealed(tx, dep)
    else log(DIM(`mempool: ${from} -> ${tx.to}`))
  } catch (e) {
    log(`bot: ignored tx (${e.message.split('\n')[0]})`) // the user's tx must still go out
  }
  const hash = await rpc('eth_sendRawTransaction', [raw])
  if (back) back(hash).catch((e) => log(`bot: back leg failed: ${e.message}`))
  return hash
}

async function handle(req) {
  if (req.method !== 'eth_sendRawTransaction') {
    return fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }).then((r) => r.json())
  }
  try {
    return { jsonrpc: '2.0', id: req.id, result: await sendRaw(req.params[0]) }
  } catch (e) {
    return { jsonrpc: '2.0', id: req.id, error: e.rpc ?? { code: -32000, message: e.message } }
  }
}

createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  const msg = JSON.parse(body)
  const out = Array.isArray(msg) ? await Promise.all(msg.map(handle)) : await handle(msg)
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
}).listen(MEMPOOL_PORT, '127.0.0.1', () => log(`sniper: watching the mempool on http://127.0.0.1:${MEMPOOL_PORT} (upstream ${RPC_URL}), bot owner ${owner.address}`))
