// A "protected" RPC that leaks. On eth_sendRawTransaction it signs a BondRegistry `Protected` receipt for the tx
// (maxPayout from the tx's own slippage, the sender as beneficiary, acceptedAt = now, before inclusion), hands the
// tx to whoever listens (the sandwich bot), and only then forwards it. Every other request is proxied unchanged.
import { createServer } from 'node:http'
import { keccak256, parseTransaction, recoverTransactionAddress } from 'viem'
import { maxPayoutFor, receiptDomain, receiptTypes } from './lib.mjs'

/**
 * @param upstream   JSON-RPC URL of the real chain
 * @param signer     viem account that is bonded in the registry (anvil account 4)
 * @param cover      async (tx, from) => { amountIn, quoteOut, minOut } for txs it prices coverage for, else null
 * @param onLeak     async (raw, tx, from) => void, awaited before the tx is forwarded
 * @param onReceipt  (entry) => void with { receipt, sig }, uint fields as decimal strings
 */
export function createLeakyRpc({
  upstream, signer, registry, chainId, cover, onLeak = async () => {}, onReceipt = () => {}, maxBlocks = 10n,
  now = () => Math.floor(Date.now() / 1000),
}) {
  const call = async (method, params) => {
    const res = await fetch(upstream, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const j = await res.json()
    if (j.error) throw Object.assign(new Error(j.error.message), { rpc: j.error })
    return j.result
  }

  async function sendRaw(raw) {
    const tx = parseTransaction(raw)
    const from = await recoverTransactionAddress({ serializedTransaction: raw })
    const c = await cover(tx, from)
    const maxPayout = c ? maxPayoutFor(c.amountIn, c.quoteOut, c.minOut) : 0n
    if (maxPayout > 0n) {
      const receipt = {
        txHash: keccak256(raw), chainId: BigInt(chainId), acceptedAt: BigInt(now()),
        maxBlock: BigInt(await call('eth_blockNumber', [])) + maxBlocks, maxPayout, beneficiary: from,
      }
      const sig = await signer.signTypedData({
        domain: receiptDomain(chainId, registry), types: receiptTypes, primaryType: 'Protected', message: receipt,
      })
      onReceipt({ receipt: Object.fromEntries(Object.entries(receipt).map(([k, v]) => [k, String(v)])), sig })
    }
    // a failing listener must not keep the user's tx from going out
    await onLeak(raw, tx, from).catch((e) => console.error(`rpc: leak listener failed: ${e.message}`))
    return call('eth_sendRawTransaction', [raw])
  }

  async function handle(req) {
    if (req.method !== 'eth_sendRawTransaction') {
      return fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
        .then((r) => r.json())
    }
    try {
      return { jsonrpc: '2.0', id: req.id, result: await sendRaw(req.params[0]) }
    } catch (e) {
      return { jsonrpc: '2.0', id: req.id, error: e.rpc ?? { code: -32000, message: e.message } }
    }
  }

  return {
    handle,
    /** Serves on 127.0.0.1:port; resolves to the http.Server once listening. */
    listen(port) {
      const server = createServer(async (req, res) => {
        let body = ''
        for await (const chunk of req) body += chunk
        const msg = JSON.parse(body)
        const out = Array.isArray(msg) ? await Promise.all(msg.map(handle)) : await handle(msg)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
      })
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
    },
  }
}
