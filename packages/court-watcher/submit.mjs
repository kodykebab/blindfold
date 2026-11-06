// The watcher's submit and collect stages (S21, #27): `BondRegistry.claim` with the victim tx's signed Protected
// receipt, then `collect` once the incident's claim window has closed. Receipts are JSON lines of { receipt, sig },
// as the protected RPC writes them (packages/demo-bots).
import { existsSync, readFileSync } from 'node:fs'
import {
  ContractFunctionRevertedError, decodeAbiParameters, encodeAbiParameters, keccak256, parseEventLogs, toFunctionSelector,
} from 'viem'

const V4_INITIALIZE = keccak256(
  new TextEncoder().encode('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'),
)

/** Receipts by lower-case tx hash, from a JSON-lines file; missing file = none. */
export function loadReceipts(path) {
  const out = new Map()
  if (!existsSync(path)) return out
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const { receipt: r, sig } = JSON.parse(line)
    const receipt = {
      ...r, chainId: BigInt(r.chainId), acceptedAt: BigInt(r.acceptedAt), maxBlock: BigInt(r.maxBlock),
      maxPayout: BigInt(r.maxPayout),
    }
    out.set(r.txHash.toLowerCase(), { receipt, sig })
  }
  return out
}

/** SandwichCourtVerifier.Claim from a prove.mjs claim file; no `anchor` = the local BLOCKHASH/EIP-2935 path. */
export function claimArgs(f) {
  const leg = (l) => ({
    index: BigInt(l.index), rawTx: l.rawTx, txProof: l.txProof, receiptProof: l.receiptProof, logIndex: BigInt(l.logIndex),
  })
  const a = f.anchor ?? { header: '0x', accountProof: [], storageProof: [] }
  return {
    header: f.header, front: leg(f.front), victim: leg(f.victim), back: leg(f.back), v4: f.v4, pool: f.pool,
    poolId: f.poolId, anchor: { header: a.header, accountProof: a.accountProof, storageProof: a.storageProof },
  }
}

/** BondRegistry's `poolKey`: abi.encode(PoolKey) from the v4 pool's Initialize event, or (token0, token1, fee) for v3. */
export async function poolKeyOf(call, item) {
  const word = (hex) => '0x' + hex.slice(-40)
  if (item.v4) {
    // shortcut: one eth_getLogs over all blocks; public RPCs cap log ranges, so cache keys or bound the range there
    const [log] = await call('eth_getLogs', [
      { address: item.pool, topics: [V4_INITIALIZE, item.poolId], fromBlock: '0x0', toBlock: 'latest' },
    ])
    if (!log) throw new Error(`no Initialize log for v4 pool ${item.poolId}`)
    const [fee, tickSpacing, hooks] = decodeAbiParameters(
      [{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }], log.data,
    )
    const key = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [word(log.topics[2]), word(log.topics[3]), fee, tickSpacing, hooks],
    )
    if (keccak256(key) !== item.poolId) throw new Error(`Initialize log does not hash to pool ${item.poolId}`)
    return key
  }
  const read = (sig) => call('eth_call', [{ to: item.pool, data: toFunctionSelector(sig) }, 'latest'])
  const [t0, t1, fee] = await Promise.all([read('token0()'), read('token1()'), read('fee()')])
  return encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], [word(t0), word(t1), Number(BigInt(fee))],
  )
}

/**
 * @param call     (method, params) => result, on the chain the sandwiches happen on (for pool keys)
 * @param client   viem public client on the registry's chain; wallet: a viem wallet client with an account there
 * @param receipts () => Map from loadReceipts, re-read on every use so receipts written after start count
 */
export function createSubmitter({ call, client, wallet, registry, abi, receipts }) {
  const send = async (functionName, args) => {
    const { request } = await client
      .simulateContract({ account: wallet.account, address: registry, abi, functionName, args })
      .catch((e) => {
        // name the registry's custom error (UnsupportedPool, ClaimWindowOpen, ...) instead of a bare "reverted"
        const d = e.walk?.((x) => x instanceof ContractFunctionRevertedError)?.data
        throw d ? new Error(`${functionName} reverts ${d.errorName}(${(d.args ?? []).join(', ')})`) : e
      })
    const hash = await wallet.writeContract(request)
    const rc = await client.waitForTransactionReceipt({ hash })
    if (rc.status !== 'success') throw new Error(`${functionName} ${hash} reverted`)
    return { hash, events: parseEventLogs({ abi, logs: rc.logs }) }
  }
  return {
    // the claim window is in the registry chain's time, which can run ahead of wall-clock time (and stands still on
    // an idle anvil)
    now: async () => Number((await client.getBlock()).timestamp),
    wanted: (item) => receipts().has(item.victimTx.toLowerCase()),
    async submit(item) {
      const r = receipts().get(item.victimTx.toLowerCase())
      if (!r) throw new Error(`no receipt for ${item.victimTx}`)
      const claim = claimArgs(JSON.parse(readFileSync(item.claim.path, 'utf8')))
      const { hash, events } = await send('claim', [claim, r.receipt, r.sig, await poolKeyOf(call, item)])
      const { incident, weight } = events.find((e) => e.eventName === 'ClaimRegistered').args
      const [, , closesAt] = await client.readContract({ address: registry, abi, functionName: 'incidents', args: [incident] })
      return { tx: hash, incident, weight: weight.toString(), closesAt: Number(closesAt) }
    },
    async collect(item) {
      const { hash, events } = await send('collect', [item.victimTx])
      const { beneficiary, payout } = events.find((e) => e.eventName === 'Collected').args
      return { tx: hash, beneficiary, payout: payout.toString() }
    },
  }
}
