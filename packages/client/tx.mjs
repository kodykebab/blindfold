// Transaction outcome: confirmed, reverted, replaced or dropped, after the deployment's confirmation policy.

/** Confirmations required before an outcome counts as final: 1 on a local chain, CLIENT_CONFIRMATIONS or 3 elsewhere. */
export function confirmationsFor(dep, env = process.env) {
  const n = env.CLIENT_CONFIRMATIONS != null && env.CLIENT_CONFIRMATIONS !== '' ? Number(env.CLIENT_CONFIRMATIONS) : Number(dep.chainId) === 31337 ? 1 : 3
  if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error('CLIENT_CONFIRMATIONS must be an integer from 1 to 64')
  return n
}

/**
 * Wait for `hash` and classify it. `from`/`nonce` identify the sending slot so a vanished transaction can be told
 * apart: if the account's mined nonce is past it, something else used the slot (replaced); if not, it was dropped
 * and the same action can be sent again.
 *   { status: 'confirmed' | 'reverted', receipt }
 *   { status: 'replaced', reason: 'repriced' | 'replaced' | 'cancelled' | 'unknown', receipt?, hash }
 *   { status: 'dropped', hash }
 */
export async function confirmTx(pub, hash, { from, nonce, confirmations = 1, timeout = 120_000 } = {}) {
  let replacement
  try {
    const receipt = await pub.waitForTransactionReceipt({ hash, confirmations, timeout, onReplaced: (r) => { replacement = r } })
    if (replacement && replacement.reason !== 'repriced') {
      return { status: 'replaced', reason: replacement.reason, receipt, hash: replacement.transaction.hash }
    }
    return { status: receipt.status === 'success' ? 'confirmed' : 'reverted', receipt }
  } catch (e) {
    if (e.name !== 'WaitForTransactionReceiptTimeoutError') throw e
  }
  // Still pending in a mempool is not dropped: only conclude once the node no longer knows the transaction.
  const known = await pub.getTransaction({ hash }).then(() => true, () => false)
  if (known) throw new Error(`transaction ${hash} is still pending after ${timeout / 1000}s; run the same command again later`)
  if (from == null || nonce == null) return { status: 'dropped', hash }
  const mined = await pub.getTransactionCount({ address: from, blockTag: 'latest' })
  return mined > nonce ? { status: 'replaced', reason: 'unknown', hash } : { status: 'dropped', hash }
}

/** One sentence per outcome for the CLI, with what to do next. */
export function describeOutcome(action, o) {
  switch (o.status) {
    case 'confirmed': return `${action} confirmed in ${o.receipt.transactionHash}`
    case 'reverted': return `${action} reverted in ${o.receipt.transactionHash}; nothing changed onchain, check status before retrying`
    case 'dropped': return `${action} ${o.hash} was dropped before inclusion; nothing changed onchain, it is safe to run the command again`
    case 'replaced': return o.reason === 'cancelled'
      ? `${action} ${o.hash} was cancelled by a replacement transaction; nothing from it applied`
      : `${action} was replaced by another transaction from this account (${o.hash}); check status before retrying`
    default: return `${action}: unknown outcome`
  }
}
