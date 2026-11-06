// Extension side of the bridge protocol v1 (extension-team/INTERFACES.md, "Extension <-> bridge page").
// The bridge page holds the user's wallet; the extension sends it finished calls to sign and learns the hashes.
import { toHex } from 'viem'

/**
 * origin: the only bridge origin accepted (D9). onWallet(msg) gets every hello/wallets/wallet message.
 * Returns {accept(port), connected(), connect(selector), send(request, onSent)}.
 */
export function bridge({ origin, onWallet = () => {}, onError = () => {} }) {
  let port = null
  const pending = new Map() // id -> {resolve, reject, onSent, saving}
  let n = 0

  function drop() {
    port = null
    onWallet({ type: 'disconnected' })
    for (const x of pending.values()) x.reject(new Error('bridge page disconnected; a transaction may still have been sent: check your wallet, then run resume or track'))
    pending.clear()
  }

  function accept(p) {
    if (p.name !== 'blindfold-bridge' || p.sender?.origin !== origin) return p.disconnect()
    if (port) { port.disconnect(); drop() } // the newest bridge page wins
    port = p
    p.onMessage.addListener((m) => {
      if (['hello', 'wallets', 'wallet'].includes(m?.type)) onWallet(m)
      else if (m?.type === 'sent') {
        const x = pending.get(m.id)
        if (x) x.saving = x.saving.then(() => x.onSent?.(m.hash ?? m.callsId, m.index))
      } else if (m?.type === 'result') {
        const x = pending.get(m.id)
        if (!x) return
        pending.delete(m.id)
        // settle only after onSent has persisted the hash, so the caller's later writes can't be overtaken
        x.saving.then(() => (m.ok ? x.resolve(m)
          : x.reject(Object.assign(new Error(`wallet: ${m.error?.message} (${m.error?.code})`), { code: m.error?.code, hashes: m.hashes }))), x.reject)
      } else if (m?.type === 'error') onError(m.error)
    })
    p.onDisconnect.addListener(() => { if (port === p) drop() })
  }

  const live = () => port ?? (() => { throw new Error(`no bridge page connected; open ${origin}/ and connect your wallet`) })()

  return {
    accept,
    connected: () => port !== null,
    connect: (selector) => live().postMessage({ type: 'connect', ...selector }),
    /**
     * One call, signed and sent by the wallet. chain: {chainId (number), rpcUrl}. onSent(hash) runs as soon as the
     * wallet accepts it, before it is mined, so the caller can persist the hash. Resolves with the bridge's result.
     */
    send({ from, to, data, value = '0x0', chain }, onSent) {
      const p = live()
      const id = `tx-${Date.now()}-${n++}`
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, onSent, saving: Promise.resolve() })
        p.postMessage({
          type: 'send', id, from, calls: [{ to, data, value }],
          chain: { chainId: toHex(chain.chainId), chainName: `Blindfold ${chain.chainId}`, rpcUrls: [chain.rpcUrl], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
        })
      })
    },
  }
}
