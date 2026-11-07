// Scriptable EIP-1193 provider for unit tests. Records every request; answers from `handlers` (value or function).
// walletLike() adds a small in-memory wallet: accounts, chain switching, sent transactions mined after a few polls.
import { EventEmitter } from 'node:events'

export function mockProvider(handlers = {}) {
  const ee = new EventEmitter()
  const p = {
    calls: [],
    handlers,
    methods: () => p.calls.map((c) => c.method),
    async request({ method, params }) {
      p.calls.push({ method, params })
      if (!(method in p.handlers)) throw { code: 4200, message: `unsupported ${method}` }
      const h = p.handlers[method]
      return typeof h === 'function' ? h(params) : h
    },
    on: (e, f) => ee.on(e, f),
    removeListener: (e, f) => ee.removeListener(e, f),
    emit: (e, v) => ee.emit(e, v),
  }
  return p
}

export const ACCOUNT = '0x00000000000000000000000000000000000000a1'

export function walletLike({ chainId = '0x7a69', accounts = [ACCOUNT], atomic, known = ['0x1', '0x7a69'], minedAfter = 1, revert = [] } = {}) {
  const w = { chainId, accounts, sent: [] }
  const receipt = (hash, i) => ({ transactionHash: hash, status: revert.includes(i) ? '0x0' : '0x1', blockNumber: '0x1' })
  const polls = new Map()
  const p = mockProvider({
    eth_requestAccounts: () => w.accounts,
    eth_accounts: () => w.accounts,
    eth_chainId: () => w.chainId,
    wallet_switchEthereumChain: ([{ chainId }]) => {
      if (!known.includes(chainId)) throw { code: 4902, message: 'unrecognized chain' }
      w.chainId = chainId
      return null
    },
    wallet_addEthereumChain: ([chain]) => { known.push(chain.chainId); w.chainId = chain.chainId; return null },
    eth_sendTransaction: ([tx]) => {
      const i = w.sent.length
      w.sent.push(tx)
      return `0x${(i + 1).toString(16).padStart(64, '0')}`
    },
    eth_getTransactionReceipt: ([hash]) => {
      const n = (polls.get(hash) ?? 0) + 1
      polls.set(hash, n)
      return n > minedAfter ? receipt(hash, Number(BigInt(hash)) - 1) : null
    },
  })
  if (atomic) {
    Object.assign(p.handlers, {
      wallet_getCapabilities: () => ({ [w.chainId]: { atomic: { status: atomic } } }),
      wallet_sendCalls: ([req]) => { w.sent.push(...req.calls); w.batch = req; return { id: 'batch-1' } },
      wallet_getCallsStatus: () => ({ status: 200, receipts: [receipt(`0x${'b'.repeat(64)}`, -1)] }),
    })
  }
  return Object.assign(p, { wallet: w })
}
