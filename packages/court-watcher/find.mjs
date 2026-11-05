// Scan recent Ethereum blocks for v3/v4 sandwiches that SandwichCourtVerifier would accept.
// Usage: N=300 node find.mjs   (scans the last N blocks)
import { rpc, ETH_RPC, getReceipts, swapLogs, findSandwiches } from './lib.mjs'

const N = Number(process.env.N || 300)
const head = BigInt(await rpc(ETH_RPC, 'eth_blockNumber'))
let blocks = 0
for (let n = head; n > head - BigInt(N); n--) {
  const receipts = await getReceipts(n)
  blocks++
  for (const s of findSandwiches(swapLogs(receipts))) {
    console.log(JSON.stringify({
      block: Number(n), v4: s.front.v4, pool: s.front.pool, poolId: s.front.poolId,
      front: [s.front.txIndex, s.front.logIndex], victim: [s.victim.txIndex, s.victim.logIndex],
      back: [s.back.txIndex, s.back.logIndex], attacker: s.front.from, victimFrom: s.victim.from,
      profit: s.profit.toString(), profitInToken0: s.profitInToken0,
    }))
  }
}
console.error(`scanned ${blocks} blocks from ${head}`)
