// Transaction outcome: confirmed, reverted, replaced or dropped, after the deployment's confirmation policy.

/** Confirmations required before an outcome counts as final: 1 on a local chain, CLIENT_CONFIRMATIONS or 3 elsewhere. */
export function confirmationsFor(dep, env = process.env) {
  const n = env.CLIENT_CONFIRMATIONS != null && env.CLIENT_CONFIRMATIONS !== '' ? Number(env.CLIENT_CONFIRMATIONS) : Number(dep.chainId) === 31337 ? 1 : 3
  if (!Number.isInteger(n) || n < 1 || n > 64) throw new Error('CLIENT_CONFIRMATIONS must be an integer from 1 to 64')
  return n
}

/**
 * Wait for `hash` and classify it. `from`/`nonce` identify the sending slot so a missing transaction can be told
 * apart: once the account's mined nonce is past it without our receipt, something else used the slot (replaced);
 * if the node forgets it and the slot is unused, it was dropped and the same action can be sent again.
 *   { status: 'confirmed' | 'reverted', receipt }
 *   { status: 'replaced', reason: 'unknown', hash }
 *   { status: 'dropped', hash }
 * Polls itself: viem 2.21's waitForTransactionReceipt never clears its timeout timer, which kept the CLI alive.
 */
export async function confirmTx(pub, hash, { from, nonce, confirmations = 1, timeout = 120_000, interval = 250, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const receiptOf = () => pub.getTransactionReceipt({ hash }).catch((e) => { if (e.name === 'TransactionReceiptNotFoundError') return null; throw e })
  const deadline = Date.now() + timeout
  for (;;) {
    let receipt = await receiptOf()
    if (receipt) {
      const depth = await pub.getBlockNumber({ cacheTime: 0 }) - receipt.blockNumber + 1n
      if (depth >= BigInt(confirmations)) {
        // A reorg can move or remove the receipt: only report it if it is still where it was.
        const again = await receiptOf()
        if (again?.blockHash === receipt.blockHash) return { status: again.status === 'success' ? 'confirmed' : 'reverted', receipt: again }
      }
    } else if (from != null && nonce != null && await pub.getTransactionCount({ address: from, blockTag: 'latest' }) > nonce) {
      // shortcut: a replacement is not inspected, so a repriced copy of the same call also reads as replaced; inspect the slot's mined tx if users reprice.
      if (!await receiptOf()) return { status: 'replaced', reason: 'unknown', hash } // re-read: ours may have landed between the two calls
      continue
    }
    if (Date.now() >= deadline) break
    await sleep(interval)
  }
  // Still pending in a mempool is not dropped: only conclude once the node no longer knows the transaction.
  const known = await pub.getTransaction({ hash }).then(() => true, (error) => {
    if (error.name === 'TransactionNotFoundError') return false
    throw error
  })
  if (known) throw new Error(`transaction ${hash} is still pending after ${timeout / 1000}s; run the same command again later`)
  return { status: 'dropped', hash }
}

/** One sentence per outcome for the CLI, with what to do next. */
export function describeOutcome(action, o) {
  switch (o.status) {
    case 'confirmed': return `${action} confirmed in ${o.receipt.transactionHash}`
    case 'reverted': return `${action} reverted in ${o.receipt.transactionHash}; nothing changed onchain, check status before retrying`
    case 'dropped': return `${action} ${o.hash} is no longer known to this RPC; check onchain status before retrying`
    case 'replaced': return `${action} ${o.hash} was replaced by another transaction from this account; check status before retrying`
    default: return `${action}: unknown outcome`
  }
}
