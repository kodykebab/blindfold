// Settles every Blindfold batch whose settle window is open: finds the band of prices settle accepts and sends
// its midpoint (REVIEW.md R4). If no price fills everyone fully, one order fills partially (R1) when the
// deployed settlement has the 4-argument settle overload.
//   npm start            # keep settling, polling every POLL_MS
//   npm start -- --once  # settle what is due now, then exit (non-zero if a due batch can't be settled)
import { readFileSync } from 'node:fs'
import { BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient, defineChain, http } from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { solve } from './price.mjs'

const E = process.env
const RPC_URL = E.RPC_URL || 'http://127.0.0.1:8545'
const DEPLOYMENTS = E.DEPLOYMENTS || new URL('../../deployments/blindfold.local.json', import.meta.url)
const ARTIFACT = E.SETTLEMENT_ARTIFACT || new URL('../../contracts/out/BlindfoldSettlement.sol/BlindfoldSettlement.json', import.meta.url)
const POLL_MS = Number(E.POLL_MS || 3000)
// anvil's public test mnemonic; account 2 is the solver (PLAN.md seams)
const account = E.SOLVER_KEY
  ? privateKeyToAccount(E.SOLVER_KEY)
  : mnemonicToAccount(E.MNEMONIC || 'test test test test test test test test test test test junk', { addressIndex: 2 })

function readJson(path, hint) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    console.error(`solver: can't read ${path} (${e.code ?? e.message}). ${hint}`)
    process.exit(1)
  }
}
const dep = readJson(DEPLOYMENTS, 'Run DeployBlindfold first, or set DEPLOYMENTS.')
const { abi } = readJson(ARTIFACT, 'Run `forge build` in contracts/, or set SETTLEMENT_ARTIFACT.')
const address = dep.settlement
if (!address) {
  console.error(`solver: ${DEPLOYMENTS} has no "settlement" address`)
  process.exit(1)
}
const hasMarginal = abi.some((f) => f.type === 'function' && f.name === 'settle' && f.inputs.length === 4)
const chain = defineChain({
  id: dep.chainId, name: 'blindfold', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
})
const pub = createPublicClient({ chain, transport: http(RPC_URL) })
const wallet = createWalletClient({ account, chain, transport: http(RPC_URL) })
const read = (functionName, args = []) => pub.readContract({ address, abi, functionName, args })

/** Batches in their settle window, not finalized, with funded revealed orders. */
async function dueBatches() {
  const now = (await pub.getBlock()).timestamp
  const cur = await read('currentBatch')
  const span = (await read('settleCloses', [cur])) - (await read('commitsClose', [cur]))
  const lookback = span / BigInt(await read('batchLength')) + 1n
  const due = []
  for (let b = cur; b >= 0n && cur - b <= lookback; b--) {
    if (now < (await read('revealCloses', [b])) || now >= (await read('settleCloses', [b]))) continue
    if (await read('finalized', [b])) continue
    const ids = await read('orderIdsOf', [b])
    if (ids.length) due.push({ b, ids })
  }
  return due
}

async function simulate(b, priceX96, marginal) {
  try {
    const args = marginal ? [b, priceX96, marginal.id, marginal.amountIn] : [b, priceX96]
    await pub.simulateContract({ address, abi, functionName: 'settle', args, account })
    return { ok: true }
  } catch (e) {
    const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null
    if (revert?.data?.errorName === 'NotMarginalPrice') return { ok: false, poolX96: revert.data.args[1] }
    return { ok: false, error: revert?.data?.errorName ?? e.shortMessage }
  }
}

async function settleBatch({ b, ids }) {
  const orders = await Promise.all(ids.map(async (id) => ({ id, ...(await read('getOrder', [id])) })))
  const [poolX96, tol] = await Promise.all([read('poolPriceX96'), read('toleranceBps')])
  const sol = await solve({
    simulate: (p, m) => simulate(b, p, m), poolX96, toleranceBps: Number(tol), orders, marginal: hasMarginal,
  })
  if (!sol) {
    const why = hasMarginal ? 'no price or marginal fill settles' : 'no price fills everyone (needs the R1 settle overload)'
    throw new Error(`batch ${b}: ${why}`)
  }
  const args = sol.marginal ? [b, sol.priceX96, sol.marginal.id, sol.marginal.amountIn] : [b, sol.priceX96]
  const hash = await wallet.writeContract({ address, abi, functionName: 'settle', args })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`batch ${b}: settle tx ${hash} reverted`)
  const price = Number((sol.priceX96 * 10n ** 6n) / 2n ** 96n) / 1e6
  const how = sol.marginal ? `order ${sol.marginal.id} partly filled (${sol.marginal.amountIn})` : `band midpoint`
  console.log(`settled batch ${b}: ${orders.length} orders at ${price} token1/token0, ${how}, tx ${hash}`)
}

const once = process.argv.includes('--once')
const reported = new Map() // batch -> last error, so a stuck batch is logged once, not every poll
for (;;) {
  let failed = false
  try {
    for (const d of await dueBatches()) {
      try {
        await settleBatch(d)
      } catch (e) {
        failed = true
        const msg = e.shortMessage ?? e.message
        if (reported.get(d.b) !== msg) console.error(msg)
        reported.set(d.b, msg)
      }
    }
  } catch (e) {
    failed = true
    console.error(`solver: ${e.shortMessage ?? e.message} (RPC_URL ${RPC_URL})`)
  }
  if (once) process.exit(failed ? 1 : 0)
  await new Promise((r) => setTimeout(r, POLL_MS))
}
