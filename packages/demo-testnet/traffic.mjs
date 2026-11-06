// Victim traffic, sent through the sniper's mempool (MEMPOOL_URL). Run `npm run sniper` first.
//   npm run traffic -- swap [n]        scene 1: n victims (default all) each swap SWAP_ETH (0.004) ETH for DEMO on the
//                                      plain pool with SLIPPAGE_BPS (300) slippage; prints each one's loss vs its quote
//   npm run traffic -- blindfold [n]   scene 2: n victims commit sealed orders to the open Blindfold batch through the
//                                      client CLI, alternating sell/buy of ORDER_SIZE (10) tokens so they cross.
//                                      Run the keeper and solver against deployments/blindfold.testnet.json to settle.
import { execFile } from 'node:child_process'
import { formatEther, parseEther } from 'viem'
import {
  BLINDFOLD_FILE, E, MEMPOOL_URL, MNEMONIC, RPC_URL, SANDWICH_FILE, VICTIMS, account, artifact, here, mined, pub, readJson,
  victimIndex, wallet,
} from './common.mjs'

const ROUTER = artifact('DemoSwap.sol', 'DemoRouter')
const ERC20 = artifact('MockERC20.sol', 'MockERC20')
const SETTLEMENT = artifact('BlindfoldSettlement.sol', 'BlindfoldSettlement')

async function swap(n = VICTIMS) {
  const demo = readJson(SANDWICH_FILE, 'Run `npm run deploy` first.')
  const amountIn = parseEther(E.SWAP_ETH || '0.004')
  const slip = BigInt(E.SLIPPAGE_BPS || 300)
  let lost = 0n
  for (let i = 0; i < n; i++) {
    const victim = account(victimIndex(i))
    const args = (minOut) => [demo.poolKey, true, amountIn, minOut, victim.address]
    const { result: quote } = await pub.simulateContract({
      account: victim, address: demo.router, abi: ROUTER.abi, functionName: 'swapExactIn', args: args(0n), value: amountIn,
    })
    const before = await pub.readContract({ address: demo.token, abi: ERC20.abi, functionName: 'balanceOf', args: [victim.address] })
    const hash = await wallet(victim, MEMPOOL_URL).writeContract({
      address: demo.router, abi: ROUTER.abi, functionName: 'swapExactIn', args: args((quote * (10_000n - slip)) / 10_000n),
      value: amountIn, gas: 300_000n,
    })
    const rc = await mined(hash)
    const got = (await pub.readContract({ address: demo.token, abi: ERC20.abi, functionName: 'balanceOf', args: [victim.address] })) - before
    lost += quote - got
    const pct = Number(((quote - got) * 10_000n) / quote) / 100
    console.log(`victim${i + 1}: quoted ${formatEther(quote)} DEMO, got ${formatEther(got)} (${pct}% lost) block ${rc.blockNumber} ${hash}`)
    await new Promise((r) => setTimeout(r, 3000)) // let the bot's back leg land before the next victim quotes
  }
  console.log(`total lost to the sandwich bot: ${formatEther(lost)} DEMO`)
}

const cli = (i, args) => new Promise((resolve) => {
  execFile(process.execPath, [here('../client/cli.mjs'), ...args], {
    env: {
      ...process.env, RPC_URL: MEMPOOL_URL, DEPLOYMENTS: BLINDFOLD_FILE, MNEMONIC, CLIENT_ACCOUNT_INDEX: String(victimIndex(i)),
      CLIENT_STATE: here('.state/client'),
    },
  }, (e, out, err) => resolve({ code: e ? e.code ?? 1 : 0, out, err }))
})

async function blindfold(n = VICTIMS) {
  const dep = readJson(BLINDFOLD_FILE, 'Run `npm run deploy` first.')
  const size = E.ORDER_SIZE || '10'
  const min = String(Number(size) * 0.9)
  const victims = Array.from({ length: n }, (_, i) => i)
  // victims run concurrently (each has its own nonce and client state file), so every order lands in one batch.
  // Deposit both tokens alike first: a lone deposit of the token being sold would tell the bot the side.
  await Promise.all(victims.map(async (i) => {
    for (const t of ['token0', 'token1']) {
      const d = await cli(i, ['deposit', t, String(Number(size) * 2)])
      if (d.code) console.log(`victim${i + 1} deposit ${t} FAILED\n${d.err || d.out}`)
    }
  }))
  const read = (functionName, args) => pub.readContract({ address: dep.settlement, abi: SETTLEMENT.abi, functionName, args })
  const batch = await read('currentBatch')
  const left = Number(await read('commitsClose', [batch])) - Number((await pub.getBlock()).timestamp)
  if (left < 15) {
    console.log(`batch ${batch} closes in ${left} s; waiting for the next one`)
    await new Promise((r) => setTimeout(r, (left + 2) * 1000))
  }
  await Promise.all(victims.map(async (i) => {
    const side = i % 2 ? 'buy' : 'sell'
    const r = await cli(i, ['commit', side, size, min])
    console.log(`victim${i + 1} sealed ${side} ${size} (min ${min}): ${r.code ? `FAILED\n${r.err || r.out}` : r.out.trim().split('\n').at(-1)}`)
  }))
  console.log(`orders are sealed until the batch's drand round; keeper + solver on ${RPC_URL} reveal and settle them`)
}

const [cmd, arg] = process.argv.slice(2)
const commands = { swap, blindfold }
if (!commands[cmd]) {
  console.error(`usage: npm run traffic -- ${Object.keys(commands).join(' | ')} [n]`)
  process.exit(2)
}
await commands[cmd](arg ? Number(arg) : undefined)
process.exit(0) // open keep-alive sockets to the mempool proxy would hold the process
