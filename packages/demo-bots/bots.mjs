// Court's demo bots (PLAN.md packages/demo-bots), on a plain anvil:
//   npm start -- setup               deploys a plain (no-hook) ETH/DEMO 0.3% v4 pool on its own PoolManager, the shared
//                                    router the victim uses, and the bot's own contract; writes deployments/demo.local.json
//   npm start -- leak-and-sandwich   a victim swaps through the "protected" RPC on :8546, which signs a receipt and
//                                    leaks the tx; the bot front-runs and back-runs it in the same block
// Deploy Court in between (V4_POOL_MANAGER = the demo PoolManager, COURT_POOLS = the pool id): receipts name the
// registry. scripts/court-demo.sh runs the whole covered flow.
// Env: RPC_URL (http://127.0.0.1:8545), LEAKY_PORT (8546), MNEMONIC (anvil's), RECEIPTS (.demo/receipts.jsonl),
// VICTIM_IN (10 ETH, in wei), SLIPPAGE_BPS (300), BOT_ETH (100 ETH, in wei).
// Accounts (PLAN.md seams): 0 deployer, 4 leaky-RPC signer, 5 sandwich bot, 10 victim.
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient, createWalletClient, decodeFunctionData, defineChain, encodeAbiParameters, formatEther, http,
  keccak256, parseEther, parseGwei, zeroAddress,
} from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { planSandwich } from './lib.mjs'
import { createLeakyRpc } from './rpc.mjs'

const E = process.env
const RPC_URL = E.RPC_URL || 'http://127.0.0.1:8545'
const LEAKY_PORT = Number(E.LEAKY_PORT || 8546)
const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
const DEMO = root('deployments/demo.local.json')
const COURT = root('deployments/court.local.json')
const RECEIPTS = E.RECEIPTS || fileURLToPath(new URL('.demo/receipts.jsonl', import.meta.url))
const MNEMONIC = E.MNEMONIC || 'test test test test test test test test test test test junk'
const [deployer, rpcSigner, botOwner, victim] = [0, 4, 5, 10].map((i) => mnemonicToAccount(MNEMONIC, { addressIndex: i }))

const readJson = (path, hint) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`can't read ${path} (${e.code ?? e.message}). ${hint}`)
  }
}
/** contracts/out/<file>/<name>.json, or <name>.<solc>.json when forge compiled the file under two solc versions. */
function artifact(file, name) {
  const dir = root(`contracts/out/${file}`)
  let f = `${name}.json`
  try {
    f = readdirSync(dir).find((n) => n === f || (n.startsWith(`${name}.`) && n.endsWith('.json'))) ?? f
  } catch {}
  return readJson(`${dir}/${f}`, 'Run `forge build` in contracts/.')
}
const ROUTER = artifact('DemoSwap.sol', 'DemoRouter')
const BOT = artifact('DemoSwap.sol', 'SandwichBot')

const pub = createPublicClient({ transport: http(RPC_URL) })
const chain = defineChain({
  id: await pub.getChainId(), name: 'demo', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
})
const wallet = (account, url = RPC_URL) => createWalletClient({ account, chain, transport: http(url) })
const same = (a, b) => a?.toLowerCase() === b?.toLowerCase()
const KEY_TYPES = ['address', 'address', 'uint24', 'int24', 'address'].map((type) => ({ type }))
const poolIdOf = (k) => keccak256(encodeAbiParameters(KEY_TYPES, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]))
const eth = (wei) => `${formatEther(wei)} ETH`

async function mined(hash) {
  const rc = await pub.waitForTransactionReceipt({ hash })
  if (rc.status !== 'success') throw new Error(`tx ${hash} reverted`)
  return rc
}

async function deploy(account, file, name, args, value) {
  const { abi, bytecode } = artifact(file, name)
  return (await mined(await wallet(account).deployContract({ abi, bytecode: bytecode.object, args, value }))).contractAddress
}

async function setup() {
  const pm = await deploy(deployer, 'PoolManager.sol', 'PoolManager', [deployer.address])
  const token = await deploy(deployer, 'MockERC20.sol', 'MockERC20', ['Demo', 'DEMO', 18])
  const lp = await deploy(deployer, 'PoolModifyLiquidityTest.sol', 'PoolModifyLiquidityTest', [pm])
  const router = await deploy(deployer, 'DemoSwap.sol', 'DemoRouter', [pm])
  const bot = await deploy(botOwner, 'DemoSwap.sol', 'SandwichBot', [pm], BigInt(E.BOT_ETH || parseEther('100')))
  const key = { currency0: zeroAddress, currency1: token, fee: 3000, tickSpacing: 60, hooks: zeroAddress }
  const call = async (address, file, name, functionName, args, value) =>
    mined(await wallet(deployer).writeContract({ address, abi: artifact(file, name).abi, functionName, args, value }))
  await call(pm, 'PoolManager.sol', 'PoolManager', 'initialize', [key, 2n ** 96n]) // 1 DEMO per ETH
  await call(token, 'MockERC20.sol', 'MockERC20', 'mint', [deployer.address, parseEther('2000')])
  await call(token, 'MockERC20.sol', 'MockERC20', 'approve', [lp, parseEther('2000')])
  const fullRange = { tickLower: -887220, tickUpper: 887220, liquidityDelta: parseEther('1000'), salt: `0x${'00'.repeat(32)}` }
  // ~1000 ETH + 1000 DEMO of third-party liquidity; the helper refunds unused ETH
  await call(lp, 'PoolModifyLiquidityTest.sol', 'PoolModifyLiquidityTest', 'modifyLiquidity', [key, fullRange, '0x'], parseEther('1001'))
  const poolId = poolIdOf(key)
  const out = {
    chainId: chain.id, deployBlock: Number(await pub.getBlockNumber()), poolManager: pm, token, router, bot,
    poolKey: key, poolId,
  }
  writeFileSync(DEMO, JSON.stringify(out, null, 1))
  console.log(`setup: ETH/DEMO 0.3% pool ${poolId} on PoolManager ${pm}; router ${router}; bot ${bot}; wrote ${DEMO}`)
}

async function leakAndSandwich() {
  const demo = readJson(DEMO, 'Run `npm start -- setup` first.')
  const court = readJson(COURT, 'Run DeployCourt with COURT_POOLS set to the demo pool id first.')
  const key = demo.poolKey
  const amountIn = BigInt(E.VICTIM_IN || parseEther('10'))
  const swapArgs = (minOut) => [key, true, amountIn, minOut, victim.address]
  const quote = await pub.simulateContract({
    account: victim, address: demo.router, abi: ROUTER.abi, functionName: 'swapExactIn', args: swapArgs(0n), value: amountIn,
  })
  const minOut = (quote.result * (10_000n - BigInt(E.SLIPPAGE_BPS || 300))) / 10_000n

  // the RPC prices coverage only for router swaps that pay ETH in (the registry values profit in ETH)
  const cover = async (tx, from) => {
    if (!same(tx.to, demo.router)) return null
    const { functionName, args } = decodeFunctionData({ abi: ROUTER.abi, data: tx.data })
    if (functionName !== 'swapExactIn' || !args[1] || args[0].currency0 !== zeroAddress) return null
    const { result } = await pub.simulateContract({ account: from, address: tx.to, abi: ROUTER.abi, functionName, args, value: tx.value })
    return { amountIn: args[2], quoteOut: result, minOut: args[3] }
  }

  // the bot: on a leaked swap in its pool, the largest front leg that still lets the victim through, then a back
  // leg selling everything the front bought; tips put the front before the victim and the back after it
  let sandwich = null
  const onLeak = async (raw, tx) => {
    if (!same(tx.to, demo.router) || tx.maxPriorityFeePerGas === undefined) return
    const { args } = decodeFunctionData({ abi: ROUTER.abi, data: tx.data })
    const [k, zeroForOne, victimIn, victimMin] = args
    if (poolIdOf(k) !== demo.poolId || !zeroForOne) return // the bot holds ETH: it fronts ETH-in swaps only
    const [sqrtPriceX96, liquidity] = await pub.readContract({ address: demo.bot, abi: BOT.abi, functionName: 'poolState', args: [k] })
    const plan = planSandwich({
      sqrtPriceX96, liquidity, fee: k.fee, zeroForOne, victimIn, minOut: victimMin,
      maxFront: await pub.getBalance({ address: demo.bot }),
    })
    if (!plan) return console.log('bot: leaked swap is not worth sandwiching')
    const nonce = await pub.getTransactionCount({ address: botOwner.address, blockTag: 'pending' })
    const leg = (legArgs, i, tip, maxFee) => wallet(botOwner).writeContract({
      address: demo.bot, abi: BOT.abi, functionName: 'swap', args: legArgs, nonce: nonce + i, gas: 300_000n,
      maxPriorityFeePerGas: tip, maxFeePerGas: maxFee,
    })
    const front = await leg([k, zeroForOne, plan.frontIn], 0, tx.maxPriorityFeePerGas + parseGwei('1'), tx.maxFeePerGas + parseGwei('1'))
    const back = await leg([k, !zeroForOne, 0n], 1, tx.maxPriorityFeePerGas / 2n, tx.maxFeePerGas)
    sandwich = { front, back, plan }
    console.log(`bot: saw the leaked tx; front ${eth(plan.frontIn)} in, back sells all ${formatEther(plan.bought)} DEMO`)
  }

  const onReceipt = (entry) => {
    mkdirSync(dirname(RECEIPTS), { recursive: true })
    appendFileSync(RECEIPTS, JSON.stringify(entry) + '\n')
    const r = entry.receipt
    console.log(`rpc: signed receipt for ${r.txHash}: maxPayout ${eth(BigInt(r.maxPayout))}, beneficiary ${r.beneficiary}, acceptedAt ${r.acceptedAt}, maxBlock ${r.maxBlock}`)
  }

  const botBefore = await pub.getBalance({ address: demo.bot })
  const rpc = createLeakyRpc({
    upstream: RPC_URL, signer: rpcSigner, registry: court.bondRegistry, chainId: chain.id, cover, onLeak, onReceipt,
  })
  const server = await rpc.listen(LEAKY_PORT)
  // anvil mines every tx alone by default; hold them so the three share a block, ordered by tip
  await pub.request({ method: 'evm_setAutomine', params: [false] })
  let victimTx
  try {
    victimTx = await wallet(victim, `http://127.0.0.1:${LEAKY_PORT}`).writeContract({
      address: demo.router, abi: ROUTER.abi, functionName: 'swapExactIn', args: swapArgs(minOut), value: amountIn,
      gas: 300_000n, maxPriorityFeePerGas: parseGwei('2'),
    })
    await pub.request({ method: 'evm_mine', params: [] })
  } finally {
    await pub.request({ method: 'evm_setAutomine', params: [true] })
    server.close()
  }
  if (!sandwich) throw new Error('the bot did not sandwich the leaked tx')

  const [f, v, b] = await Promise.all([sandwich.front, victimTx, sandwich.back].map((hash) => mined(hash)))
  if (!(f.blockNumber === v.blockNumber && v.blockNumber === b.blockNumber))
    throw new Error(`legs landed in blocks ${f.blockNumber}, ${v.blockNumber}, ${b.blockNumber}`)
  if (!(f.transactionIndex < v.transactionIndex && v.transactionIndex < b.transactionIndex))
    throw new Error(`legs out of order: ${f.transactionIndex}, ${v.transactionIndex}, ${b.transactionIndex}`)
  const profit = (await pub.getBalance({ address: demo.bot })) - botBefore
  console.log(
    `sandwich: block ${v.blockNumber}, front tx ${f.transactionIndex} → victim tx ${v.transactionIndex} → back tx ${b.transactionIndex}; ` +
      `victim ${victimTx}; bot profit ${eth(profit)}`,
  )
}

const cmd = process.argv[2]
const commands = { setup, 'leak-and-sandwich': leakAndSandwich }
if (!commands[cmd]) {
  console.error(`usage: npm start -- ${Object.keys(commands).join(' | ')}`)
  process.exit(2)
}
await commands[cmd]()
