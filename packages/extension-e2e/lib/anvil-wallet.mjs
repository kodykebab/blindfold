// Test-only wallet: an EIP-1193 provider injected into the bridge page (Playwright init script), announced via
// EIP-6963, backed by an anvil test key on the Node side. Never shipped: it lives only in this harness.
// Tests steer it through `wallet` (accounts, chain, atomic support, rejections, a hold before sending) and read
// `wallet.log` (every request, so a test can assert that nothing was signed).
import { createWalletClient, http } from 'viem'
import { chain as anvil, RPC } from './chain.mjs'

export const RDNS = 'xyz.blindfold.testwallet'
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%23888'/%3E%3C/svg%3E"
const READS = new Set(['eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_getBalance', 'eth_getBlockByNumber',
  'eth_getCode', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_maxPriorityFeePerGas', 'eth_feeHistory'])

// Runs in the page before its scripts. Only on the bridge origin: other sites in a test see no wallet.
const PAGE = (origin, rdns, icon) => {
  if (location.origin !== origin) return
  const listeners = {}
  const provider = {
    async request({ method, params }) {
      const r = await window.__blindfoldTestWallet({ method, params: params ?? [] })
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code })
      return r.result
    },
    on(e, f) { (listeners[e] ??= new Set()).add(f); return provider },
    removeListener(e, f) { listeners[e]?.delete(f); return provider },
  }
  window.__blindfoldTestWalletEmit = (e, v) => listeners[e]?.forEach((f) => f(v))
  const info = Object.freeze({ uuid: crypto.randomUUID(), name: 'Blindfold test wallet', icon, rdns })
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
  window.addEventListener('eip6963:requestProvider', announce)
  announce()
}

const rpcError = (code, message) => Object.assign(new Error(message), { code })

/**
 * account: a viem local account (anvil test key). origin: the bridge origin.
 * Returns the wallet state object; mutate it from tests: accounts, chainId, atomic, reject (Set of methods
 * answered with 4001), hold (async (method, params) => void, awaited before a transaction is sent).
 * Read: log (every request), sent ({to, hash} of every transaction sent).
 */
export async function installTestWallet(context, { account, origin, accounts = [account] }) {
  const w = {
    accounts, chainId: '0x7a69', known: new Set(['0x1', '0x7a69']), atomic: false, reject: new Set(), hold: null, log: [], sent: [], batches: new Map(),
    pages: new Set(),
    /** Fire an EIP-1193 event in every bridge page. */
    async emit(event, value) {
      for (const page of w.pages) await page.evaluate(([e, v]) => window.__blindfoldTestWalletEmit?.(e, v), [event, value]).catch(() => {})
    },
    async setAccounts(list) { w.accounts = list; await w.emit('accountsChanged', w.addresses()) },
    async setChain(id) { w.chainId = id; await w.emit('chainChanged', id) },
    addresses: () => w.accounts.map((a) => a.address.toLowerCase()),
    signed: () => w.log.filter((x) => /sendTransaction|sendCalls|sign/i.test(x.method)),
  }
  const rpc = async (method, params) => {
    const r = await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
    if (r.error) throw rpcError(r.error.code, r.error.message)
    return r.result
  }
  async function sendTx(tx) {
    if (BigInt(w.chainId) !== BigInt(anvil.id)) throw rpcError(-32603, `test wallet can only send on ${anvil.id}`)
    if (tx.chainId != null && BigInt(tx.chainId) !== BigInt(w.chainId)) throw rpcError(-32602, `chainId ${tx.chainId} does not match the wallet's ${w.chainId}`)
    const signer = w.accounts.find((a) => a.address.toLowerCase() === tx.from?.toLowerCase())
    if (!signer || signer !== w.accounts[0]) throw rpcError(4100, `${tx.from} is not the selected account`)
    await w.hold?.('eth_sendTransaction', tx)
    const client = createWalletClient({ account: signer, chain: anvil, transport: http(RPC) })
    const hash = await client.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value ?? 0) })
    w.sent.push({ to: tx.to, hash })
    return hash
  }
  async function handle(method, params) {
    if (w.reject.has(method)) throw rpcError(4001, 'User rejected the request.')
    switch (method) {
      case 'eth_requestAccounts': case 'eth_accounts': return w.addresses()
      case 'eth_chainId': return w.chainId
      case 'wallet_switchEthereumChain':
        if (!w.known.has(params[0].chainId)) throw rpcError(4902, `Unrecognized chain ID ${params[0].chainId}`)
        await w.setChain(params[0].chainId)
        return null
      case 'wallet_addEthereumChain':
        w.known.add(params[0].chainId)
        return null
      case 'wallet_getCapabilities':
        return { [w.chainId]: { atomic: { status: w.atomic ? 'supported' : 'unsupported' } } }
      case 'wallet_sendCalls': {
        if (!w.atomic) throw rpcError(5760, 'atomic batching not supported')
        // shortcut: the test wallet runs the batch call by call (an EOA can't batch), mined before it answers
        const receipts = []
        for (const c of params[0].calls) {
          const hash = await sendTx({ ...c, from: params[0].from, chainId: params[0].chainId })
          receipts.push(await rpcUntil(hash))
        }
        const id = `batch-${w.batches.size + 1}`
        w.batches.set(id, receipts)
        return { id }
      }
      case 'wallet_getCallsStatus': {
        const receipts = w.batches.get(params[0])
        return { version: '2.0.0', id: params[0], status: receipts.every((r) => r.status === '0x1') ? 200 : 500, atomic: true, receipts }
      }
      case 'eth_sendTransaction': return sendTx(params[0])
      default:
        if (READS.has(method)) return rpc(method, params)
        throw rpcError(4200, `test wallet does not support ${method}`)
    }
  }
  async function rpcUntil(hash) {
    for (;;) {
      const r = await rpc('eth_getTransactionReceipt', [hash])
      if (r) return r
      await new Promise((ok) => setTimeout(ok, 50))
    }
  }
  await context.exposeBinding('__blindfoldTestWallet', async ({ page }, { method, params }) => {
    w.pages.add(page)
    w.log.push({ method, params })
    try {
      return { result: await handle(method, params) }
    } catch (e) {
      return { error: { code: e.code ?? -32603, message: e.shortMessage ?? e.message } }
    }
  })
  await context.addInitScript(`(${PAGE})(${JSON.stringify(origin)}, ${JSON.stringify(RDNS)}, ${JSON.stringify(ICON)})`)
  return w
}
