// Victim traffic, sent through the sniper's mempool (MEMPOOL_URL). Run `npm run sniper` first.
//   npm run traffic -- swap [n]        scene 1: n victims (default all) each swap SWAP_ETH (0.004) demo input tokens for output tokens on the
//                                      plain pool with SLIPPAGE_BPS (300) slippage; prints each one's loss vs its quote
//   npm run traffic -- blindfold [n] [--settle]
//                                      scene 2: n victims commit sealed orders to the open Blindfold batch through the
//                                      client CLI, alternating sell/buy of ORDER_SIZE (10) tokens so they cross.
//                                      --settle then runs the keeper and the solver once each (accounts 1 and 2) and
//                                      prints every victim's fill; without it, run them as services to settle.
import { formatEther, parseEther } from 'viem'
import { findSandwiches, rpc, swapLogs } from '../court-watcher/lib.mjs'
import {
  BLINDFOLD_FILE, E, MEMPOOL_URL, RPC_URL, SANDWICH_FILE, VICTIMS, account, artifact, demoArtifact, explorerTx, mined, pub, readJson,
  victimIndex, wallet,
} from './common.mjs'
import { cli as clientAs, openBatch, revealBatch, settleBatch } from './flow.mjs'
import { parseTrack, victimSandwich } from './lib.mjs'

const ROUTER = demoArtifact('V3Demo')
const ERC20 = artifact('MockERC20.sol', 'MockERC20')

async function swap(n = VICTIMS) {
  const demo = readJson(SANDWICH_FILE, 'Run `npm run deploy` first.')
  const amountIn = parseEther(E.SWAP_ETH || '0.004')
  const slip = BigInt(E.SLIPPAGE_BPS || 300)
  let lost = 0n
  for (let i = 0; i < n; i++) {
    const victim = account(victimIndex(i))
    await mined(await wallet(victim).writeContract({ address: demo.token0, abi: ERC20.abi, functionName: 'approve', args: [demo.router, amountIn] }))
    const args = (minOut) => [true, amountIn, minOut, victim.address]
    const { result: quote } = await pub.simulateContract({
      account: victim, address: demo.router, abi: ROUTER.abi, functionName: 'swapExactIn', args: args(0n),
    })
    const before = await pub.readContract({ address: demo.token1, abi: ERC20.abi, functionName: 'balanceOf', args: [victim.address] })
    const hash = await wallet(victim, MEMPOOL_URL).writeContract({
      address: demo.router, abi: ROUTER.abi, functionName: 'swapExactIn', args: args((quote * (10_000n - slip)) / 10_000n),
      gas: 300_000n,
    })
    const rc = await mined(hash)
    const got = (await pub.readContract({ address: demo.token1, abi: ERC20.abi, functionName: 'balanceOf', args: [victim.address] })) - before
    lost += quote - got
    const pct = Number(((quote - got) * 10_000n) / quote) / 100
    console.log(`victim${i + 1}: quoted ${formatEther(quote)} output tokens, got ${formatEther(got)} (${pct}% lost) block ${rc.blockNumber} ${explorerTx(hash)}`)
    await new Promise((r) => setTimeout(r, 3000)) // let the bot's back leg land before the next victim quotes
    const receipts = await rpc(RPC_URL, 'eth_getBlockReceipts', [`0x${rc.blockNumber.toString(16)}`])
    const sandwich = victimSandwich(findSandwiches(swapLogs(receipts)), hash, demo.pool)
    if (!sandwich) throw new Error(`victim${i + 1}: no detectable same-block v3 sandwich; check the sniper log`)
    console.log(`victim${i + 1}: detector verified front #${sandwich.front.txIndex}, victim #${sandwich.victim.txIndex}, back #${sandwich.back.txIndex}`)
  }
  console.log(`total lost to the sandwich bot: ${formatEther(lost)} output tokens`)
}

// victims send through the sniper's mempool, so the bot sees every commit
const cli = (i, args) => clientAs(victimIndex(i), args, { RPC_URL: MEMPOOL_URL })

async function blindfold(n = VICTIMS, settle = false) {
  readJson(BLINDFOLD_FILE, 'Run `npm run deploy` first.')
  const size = E.ORDER_SIZE || '10'
  const min = String(Number(size) * 0.9)
  const victims = Array.from({ length: n }, (_, i) => i)
  // victims run concurrently (each has its own nonce and client state file), so every order lands in one batch.
  // Deposit both tokens alike first: a lone deposit of the token being sold would tell the bot the side.
  await Promise.all(victims.map(async (i) => {
    for (const t of ['token0', 'token1']) {
      const d = await cli(i, ['deposit', t, String(Number(size) * 2)])
      if (d.code) throw new Error(`victim${i + 1} deposit ${t} failed: ${d.err || d.out}`)
    }
  }))
  const batch = await openBatch(15n)
  await Promise.all(victims.map(async (i) => {
    const side = i % 2 ? 'buy' : 'sell'
    const r = await cli(i, ['commit', side, size, min])
    if (r.code) throw new Error(`victim${i + 1} commit failed: ${r.err || r.out}`)
    console.log(`victim${i + 1} sealed ${side} ${size} (min ${min}): ${r.out.trim().split('\n').at(-1)}`)
  }))
  console.log(`orders are sealed until batch ${batch}'s drand round; keeper + solver on ${RPC_URL} reveal and settle them`)
  if (!settle) return
  await revealBatch(batch, n, { RPC_URL: MEMPOOL_URL })
  await settleBatch(batch, { RPC_URL: MEMPOOL_URL })
  for (const i of victims) {
    const mine = parseTrack((await cli(i, ['track'])).out).filter((c) => c.batch === Number(batch))
    if (mine.length !== 1 || mine[0].state !== 'filled') throw new Error(`victim${i + 1} did not fill in batch ${batch}`)
    for (const c of mine) console.log(`victim${i + 1} #${c.id}: ${c.state} (${c.what})${c.fill ? ` ${c.fill}` : ''}`)
  }
}

const [cmd, ...rest] = process.argv.slice(2)
const commands = { swap, blindfold }
if (!commands[cmd]) {
  console.error(`usage: npm run traffic -- ${Object.keys(commands).join(' | ')} [n] [--settle]`)
  process.exit(2)
}
const n = rest.find((a) => /^\d+$/.test(a))
await commands[cmd](n ? Number(n) : undefined, rest.includes('--settle'))
process.exit(0) // open keep-alive sockets to the mempool proxy would hold the process
