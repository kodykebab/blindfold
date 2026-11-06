// Pure keeper logic: what is due now, how to read an opened ciphertext, how to class a failed send, the budget gate.
import { BaseError, ContractFunctionRevertedError, toFunctionSelector } from 'viem'

export const COMMITTED = 1 // BatchAuction.Status.Committed

/**
 * Work due at chain time `now`.
 * commitments: [{id, batchId, status, hash, committer, round, ciphertext}] (status from chain);
 * batches: Map(batchId → {revealOpens, revealCloses, settleCloses, finalized, orders}).
 * reveal: committed and inside its reveal window; slash: committed after it; expire: unsettled batch with locked
 * orders after its settle deadline; settle: the same batch inside its settle window once `settleGrace` seconds have
 * passed since reveals closed without a solver settling it (null grace: never).
 */
export function due(commitments, batches, now, settleGrace = null) {
  const reveal = []
  const slash = []
  for (const c of commitments) {
    if (c.status !== COMMITTED) continue
    const b = batches.get(c.batchId)
    if (now >= b.revealCloses) slash.push(c)
    else if (now >= b.revealOpens) reveal.push(c)
  }
  const open = [...batches].filter(([, b]) => !b.finalized && b.orders > 0n)
  const expire = open.filter(([, b]) => now >= b.settleCloses).map(([id]) => id)
  const settle = settleGrace === null ? [] : open
    .filter(([, b]) => now >= b.revealCloses + BigInt(settleGrace) && now < b.settleCloses).map(([id]) => id)
  return { reveal, slash, expire, settle }
}

/** Batches a `solver.mjs --once` run reports as settled ("settled batch N: ..."). */
export const settledBatches = (output) => [...output.matchAll(/^settled batch (\d+):/gm)].map((m) => BigInt(m[1]))

/**
 * Turn a decrypted payload into reveal arguments, or say why not. A payload that doesn't match its commitment would
 * revert, so it is left for slashUnrevealed after the window.
 */
export function opened(c, payload, { chainId, settlement, orderHash }) {
  if (orderHash(chainId, settlement, c.batchId, payload.order, payload.salt) !== c.hash) return { ok: false, why: 'payload does not match the commitment hash' }
  if (payload.order.owner.toLowerCase() !== c.committer.toLowerCase()) return { ok: false, why: 'order owner is not the committer' }
  return { ok: true, args: [c.id, payload.order, payload.salt] }
}

/** Custom error name of a reverted call, or its raw selector when viem couldn't decode it (it happens on sends). */
export function revertName(e) {
  const r = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null
  return r?.data?.errorName ?? r?.signature ?? null
}

const RACE = ['BadStatus(uint256)', 'Finalized(uint64)'].flatMap((sig) => [sig.split('(')[0], toFunctionSelector(sig)])

/**
 * Another sender got there first (REVIEW S8): the commitment is no longer Committed, or the batch is already
 * finalized. That is the protocol working, not a keeper failure.
 */
export const lostRace = (e) => RACE.includes(revertName(e))

/** Whether the keeper may send another transaction (REVIEW S7: an explicit budget and a balance floor). */
export function canSpend({ spent, budget, balance, minBalance }) {
  if (budget != null && spent >= budget) return { ok: false, why: `budget exhausted (${spent} of ${budget} wei spent)` }
  if (balance < minBalance) return { ok: false, why: `balance ${balance} wei below the ${minBalance} wei floor` }
  return { ok: true }
}
