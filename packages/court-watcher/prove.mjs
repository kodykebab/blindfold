// Build a claim fixture for a sandwich found by find.mjs.
// Usage: BLOCK=<n> FRONT=<i>:<log> VICTIM=<i>:<log> BACK=<i>:<log> [V4=1 POOL=.. POOLID=..] OUT=path node prove.mjs
// With ANCHOR=1 it also builds the L1 anchor from Base's L1Block (run promptly: needs eth_getProof at a recent block).
import { writeFileSync } from 'node:fs'
import { keccak256, toHex, pad, toFunctionSelector } from 'viem'
import {
  rpc, ETH_RPC, BASE_RPC, HISTORY, HISTORY_WINDOW, V4_POOL_MANAGER,
  getBlock, getReceipts, getRawTxs, headerRlp, receiptRlp, buildTrie, proofFor, rootOf,
} from './lib.mjs'

const E = process.env
const BLOCK = BigInt(E.BLOCK)
const leg = (s) => s.split(':').map(Number)
const [fI, fL] = leg(E.FRONT), [vI, vL] = leg(E.VICTIM), [bI, bL] = leg(E.BACK)
const V4 = E.V4 === '1'
const POOL = V4 ? V4_POOL_MANAGER : E.POOL
const POOLID = V4 ? E.POOLID : '0x' + '00'.repeat(32)
const OUT = E.OUT || '../../contracts/test/court/fixtures/sandwich.json'

const block = await getBlock(BLOCK)
const header = headerRlp(block)
if (keccak256(header) !== block.hash) throw new Error('header RLP does not hash to the block hash')

const raws = await getRawTxs(block)
const receipts = (await getReceipts(BLOCK)).sort((a, b) => Number(a.transactionIndex) - Number(b.transactionIndex))
const txTrie = await buildTrie(raws)
const rcTrie = await buildTrie(receipts.map(receiptRlp))
if (rootOf(txTrie) !== block.transactionsRoot) throw new Error('tx root mismatch')
if (rootOf(rcTrie) !== block.receiptsRoot) throw new Error('receipt root mismatch')

const mkLeg = async (i, l) => ({
  index: i, rawTx: raws[i], txProof: await proofFor(txTrie, i), receiptProof: await proofFor(rcTrie, i), logIndex: l,
})
const out = {
  blockNumber: Number(BLOCK), blockHash: block.hash, header,
  front: await mkLeg(fI, fL), victim: await mkLeg(vI, vL), back: await mkLeg(bI, bL),
  v4: V4, pool: POOL, poolId: POOLID,
  attacker: receipts[fI].from.toLowerCase(), victimFrom: receipts[vI].from.toLowerCase(),
  historyCode: await rpc(ETH_RPC, 'eth_getCode', [HISTORY, 'latest']),
}

if (E.ANCHOR === '1') {
  // The anchor must be an L1 block Base has actually reported.
  const L1_BLOCK = '0x4200000000000000000000000000000000000015'
  const call = async (sig) => rpc(BASE_RPC, 'eth_call', [{ to: L1_BLOCK, data: sig }, 'latest'])
  const anchorNumber = BigInt(await call(toFunctionSelector('number()')))
  const anchorHash = await call(toFunctionSelector('hash()'))
  const ab = await getBlock(anchorNumber)
  if (ab.hash !== anchorHash) throw new Error('Base L1Block hash differs from Ethereum')
  if (anchorNumber - BLOCK > HISTORY_WINDOW || anchorNumber <= BLOCK) throw new Error('target outside anchor window')
  const slot = pad(toHex(BLOCK % HISTORY_WINDOW), { size: 32 })
  const proof = await rpc(ETH_RPC, 'eth_getProof', [HISTORY, [slot], toHex(anchorNumber)])
  out.anchor = {
    number: Number(anchorNumber), hash: anchorHash, header: headerRlp(ab),
    accountProof: proof.accountProof, storageProof: proof.storageProof[0].proof,
  }
  if (keccak256(out.anchor.header) !== anchorHash) throw new Error('anchor header mismatch')
}

writeFileSync(OUT, JSON.stringify(out, null, 1))
const size = JSON.stringify(out).length
console.log(`wrote ${OUT} (${size} bytes)`, out.anchor ? `anchor ${out.anchor.number}` : '')
