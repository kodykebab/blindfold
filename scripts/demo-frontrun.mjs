// Demo: a bot tries to front-run the sealed orders in a running dev stack and is rejected on chain.
//   node scripts/demo-frontrun.mjs <stack-dir>
// It prints the open batch's commitments (ciphertext only, nothing readable before the drand round), then sends a real
// swap into the Blindfold pool from a bot account. The pool's hook lets only the settlement contract swap, so the
// transaction reverts with OnlySettlement(bot). Exits 1 if the swap were ever accepted.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const dir = process.argv[2]
if (!dir) { console.error('usage: node scripts/demo-frontrun.mjs <stack-dir>'); process.exit(2) }
const env = Object.fromEntries(readFileSync(join(dir, 'stack.env'), 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/^'(.*)'$/, '$1')]))
const require = createRequire(new URL('../packages/solver/package.json', import.meta.url))
const { createPublicClient, createWalletClient, defineChain, http, parseEther, toFunctionSelector, toHex } = require('viem')
const { mnemonicToAccount } = require('viem/accounts')
const { artifactPath } = await import('../packages/solver/artifacts.mjs')
const art = (name) => JSON.parse(readFileSync(artifactPath(env.CONTRACTS_OUT, name), 'utf8'))
const dep = JSON.parse(readFileSync(env.DEPLOYMENTS, 'utf8'))
const chain = defineChain({ id: Number(dep.chainId), name: 'Blindfold local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [env.RPC_URL] } } })
const pub = createPublicClient({ chain, transport: http(env.RPC_URL), pollingInterval: 200 })
const bot = mnemonicToAccount(env.MNEMONIC, { addressIndex: 5 })
const wallet = createWalletClient({ account: bot, chain, transport: http(env.RPC_URL) })
const settlement = art('AdmittedSettlement').abi
const read = (functionName, args = []) => pub.readContract({ address: dep.settlement, abi: settlement, functionName, args })
const wait = async (hash) => pub.waitForTransactionReceipt({ hash })

// 1. What a searcher can see: commitments, not orders.
const now = (await pub.getBlock()).timestamp
const logs = await pub.getContractEvents({ address: dep.settlement, abi: settlement, eventName: 'Committed', fromBlock: 0n })
console.log(`\n== What a searcher sees in the open batches (${logs.length} commitment(s))`)
for (const { args } of logs.slice(-6)) {
  const opens = await read('revealOpens', [args.batchId])
  const ct = args.ciphertext ?? '0x'
  console.log(`  #${args.commitId} batch ${args.batchId}: ${(ct.length - 2) / 2} bytes of ciphertext ${ct.slice(0, 26)}…  ` +
    (now < opens ? `unreadable until drand round ${args.round} (in ${opens - now}s)` : `drand round ${args.round} is out; revealable now`))
}
if (!logs.length) console.log('  (no orders yet: commit one on the page first)')

// 2. The front-run: swap straight into the Blindfold pool ahead of the batch.
console.log(`\n== Bot ${bot.address} tries to swap in the pool before the batch settles`)
const key = await read('poolKey')
const router = (await wait(await wallet.deployContract({ abi: art('PoolSwapTest').abi, bytecode: art('PoolSwapTest').bytecode.object, args: [await read('manager')] }))).contractAddress
for (const token of [key.currency0, key.currency1]) {
  await wait(await wallet.writeContract({ address: token, abi: art('MockERC20').abi, functionName: 'mint', args: [bot.address, parseEther('100')] }))
  await wait(await wallet.writeContract({ address: token, abi: art('MockERC20').abi, functionName: 'approve', args: [router, (1n << 256n) - 1n] }))
}
const MIN_SQRT_PRICE_PLUS_ONE = 4295128740n
const hash = await wallet.writeContract({ address: router, abi: art('PoolSwapTest').abi, functionName: 'swap', gas: 1_000_000n,
  args: [key, { zeroForOne: true, amountSpecified: -parseEther('10'), sqrtPriceLimitX96: MIN_SQRT_PRICE_PLUS_ONE }, { takeClaims: false, settleUsingBurn: false }, '0x'] })
const receipt = await wait(hash)
if (receipt.status === 'success') { console.log(`  ✗ UNEXPECTED: the swap went through (${hash})`); process.exit(1) }
// v4 wraps the hook's revert; look for OnlySettlement in the trace to name the reason.
const selector = toFunctionSelector('OnlySettlement(address)').slice(2)
let named = false
try { named = JSON.stringify(await pub.request({ method: 'debug_traceTransaction', params: [hash, {}] })).includes(selector) } catch {}
console.log(`  ✓ Rejected on chain: transaction ${hash} reverted in block ${receipt.blockNumber}`)
console.log(`    ${named ? `the pool's hook refused it with OnlySettlement(${bot.address})` : 'the pool\'s hook refused it'}: only the Blindfold settlement contract may swap in this pool,`)
console.log('    and it only does so once per batch, at the single clearing price, after every order is revealed.\n')
