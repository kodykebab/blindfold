// Shared helpers: JSON-RPC, header/receipt RLP encoding, trie proofs, Swap log parsing.
import { Trie } from '@ethereumjs/trie'
import { hexToBytes, bytesToHex } from '@ethereumjs/util'
import { toRlp, keccak256, numberToHex, toFunctionSelector } from 'viem'

export const ETH_RPC = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com'
export const BASE_RPC = process.env.BASE_RPC || 'https://mainnet.base.org'

export const V3_SWAP = keccak256(new TextEncoder().encode('Swap(address,address,int256,int256,uint160,uint128,int24)'))
export const V4_SWAP = keccak256(new TextEncoder().encode('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'))
// Ethereum mainnet's by default; set V4_POOL_MANAGER (and ETH_RPC) to scan another chain, e.g. a local Unichain fork
export const V4_POOL_MANAGER = (process.env.V4_POOL_MANAGER || '0x000000000004444c5dc75cb358380d2e3de08a90').toLowerCase()
export const HISTORY = '0x0000f90827f1c53a10cb7a02335b175320002935' // EIP-2935
export const HISTORY_WINDOW = 8191n
export const L1_BLOCK = '0x4200000000000000000000000000000000000015' // OP-stack L1 attributes predeploy
const RPC_TIMEOUT_MS = Number(process.env.RPC_TIMEOUT_MS || 15_000)

let id = 0
export async function rpc(url, method, params = [], tries = 5) {
  for (let t = 0; ; t++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS), // a hung RPC fails the call instead of stalling the watcher
      })
      const j = await res.json()
      if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`)
      return j.result
    } catch (e) {
      if (t + 1 >= tries) throw e
      await new Promise((r) => setTimeout(r, 500 * 2 ** t))
    }
  }
}

/**
 * The L1 block Base's L1Block predeploy reports, with number and hash read at one Base block. Two reads at
 * 'latest' can straddle a Base block and pair one L1 block's number with another's hash.
 */
export async function l1Anchor(call = (method, params) => rpc(BASE_RPC, method, params)) {
  const at = await call('eth_blockNumber', [])
  const read = (sig) => call('eth_call', [{ to: L1_BLOCK, data: toFunctionSelector(sig) }, at])
  const [number, hash] = await Promise.all([read('number()'), read('hash()')])
  return { number: BigInt(number), hash: '0x' + hash.slice(-64), baseBlock: BigInt(at) }
}

/** RLP quantity: minimal big-endian, zero = empty string. */
export const q = (x) => (x === undefined || x === null || BigInt(x) === 0n ? '0x' : numberToHex(BigInt(x)))

/** Header RLP with every field the block carries (London through Prague). */
export function headerRlp(b) {
  const f = [
    b.parentHash, b.sha3Uncles, b.miner, b.stateRoot, b.transactionsRoot, b.receiptsRoot, b.logsBloom,
    q(b.difficulty), q(b.number), q(b.gasLimit), q(b.gasUsed), q(b.timestamp), b.extraData, b.mixHash, b.nonce,
  ]
  const optional = [
    ['baseFeePerGas', q], ['withdrawalsRoot', (x) => x], ['blobGasUsed', q], ['excessBlobGas', q],
    ['parentBeaconBlockRoot', (x) => x], ['requestsHash', (x) => x],
  ]
  for (const [k, enc] of optional) if (b[k] !== undefined) f.push(enc(b[k]))
  return toRlp(f)
}

export function receiptRlp(r) {
  const body = toRlp([
    BigInt(r.status) === 1n ? '0x01' : '0x',
    q(r.cumulativeGasUsed),
    r.logsBloom,
    r.logs.map((l) => [l.address, l.topics, l.data]),
  ])
  const type = Number(r.type)
  return type === 0 ? body : `0x${type.toString(16).padStart(2, '0')}${body.slice(2)}`
}

export async function buildTrie(values) {
  const trie = new Trie()
  for (let i = 0; i < values.length; i++) await trie.put(hexToBytes(toRlp(q(i))), hexToBytes(values[i]))
  return trie
}

export async function proofFor(trie, index) {
  return (await trie.createProof(hexToBytes(toRlp(q(index))))).map(bytesToHex)
}

export const rootOf = (trie) => bytesToHex(trie.root())

export async function getBlock(n) {
  return rpc(ETH_RPC, 'eth_getBlockByNumber', [typeof n === 'string' ? n : numberToHex(BigInt(n)), false])
}

export async function getReceipts(n) {
  return rpc(ETH_RPC, 'eth_getBlockReceipts', [numberToHex(BigInt(n))])
}

export async function getRawTxs(block) {
  const out = []
  for (let i = 0; i < block.transactions.length; i++) {
    out.push(await rpc(ETH_RPC, 'eth_getRawTransactionByBlockNumberAndIndex', [block.number, numberToHex(i)]))
  }
  return out
}

const signed = (hex, bits) => {
  let x = BigInt(hex)
  if (x >> BigInt(bits - 1)) x -= 1n << BigInt(bits)
  return x
}

/**
 * Swap logs in a block's receipts, normalised to the v3 pool-side convention (positive = paid into pool).
 * v4 events are swapper-side, so their amounts are negated.
 */
export function swapLogs(receipts) {
  const out = []
  for (const r of receipts) {
    if (BigInt(r.status) !== 1n) continue
    r.logs.forEach((l, logIndex) => {
      const t0 = l.topics[0]
      if (t0 === V3_SWAP && l.topics.length >= 3) {
        out.push({
          v4: false, pool: l.address.toLowerCase(), poolId: '0x' + '00'.repeat(32),
          txIndex: Number(r.transactionIndex), txHash: r.transactionHash, logIndex, from: r.from.toLowerCase(),
          caller: '0x' + l.topics[1].slice(26), // v3 `sender`: the contract that called the pool
          a0: signed('0x' + l.data.slice(2, 66), 256), a1: signed('0x' + l.data.slice(66, 130), 256),
        })
      } else if (t0 === V4_SWAP && l.address.toLowerCase() === V4_POOL_MANAGER && l.topics.length >= 3) {
        out.push({
          v4: true, pool: V4_POOL_MANAGER, poolId: l.topics[1],
          txIndex: Number(r.transactionIndex), txHash: r.transactionHash, logIndex, from: r.from.toLowerCase(),
          caller: '0x' + l.topics[2].slice(26), // v4 `sender`: the contract that called the PoolManager
          a0: -signed('0x' + l.data.slice(2, 66), 256), a1: -signed('0x' + l.data.slice(66, 130), 256),
        })
      }
    })
  }
  return out
}

/** Same predicate as SandwichCourtVerifier._predicate plus the signer check (front.from == back.from != victim.from). */
export function findSandwiches(swaps, closeBps = 100n) {
  const found = []
  const byPool = new Map()
  for (const s of swaps) {
    const k = s.pool + s.poolId
    if (!byPool.has(k)) byPool.set(k, [])
    byPool.get(k).push(s)
  }
  for (const list of byPool.values()) {
    for (let a = 0; a < list.length; a++) for (let c = a + 1; c < list.length; c++) {
      const f = list[a], b = list[c]
      if (b.txIndex <= f.txIndex + 1) continue
      if (f.from !== b.from || f.caller !== b.caller) continue // one signer, one contract making both legs
      const z = f.a0 > 0n
      if ((b.a0 > 0n) === z) continue
      const bought = -(z ? f.a1 : f.a0), sold = z ? b.a1 : b.a0
      const diff = bought > sold ? bought - sold : sold - bought
      if (bought <= 0n || diff * 10000n > bought * closeBps) continue
      const spent = z ? f.a0 : f.a1
      const profit = -(z ? b.a0 : b.a1) - spent
      if (spent <= 0n || profit <= 0n) continue
      for (const v of list) {
        if (v.txIndex <= f.txIndex || v.txIndex >= b.txIndex) continue
        if ((v.a0 > 0n) !== z || v.from === f.from) continue // any route: a shared router is not the trader
        found.push({ front: f, victim: v, back: b, profit, profitInToken0: z })
        break
      }
    }
  }
  return found
}
