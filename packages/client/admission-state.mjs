// The private opening of the onchain cumulative funding root. No history is discarded while a submission is uncertain.
import { encodeAbiParameters, keccak256 } from 'viem'
export const ZERO = `0x${'00'.repeat(32)}`
const uint = (n, bits) => typeof n === 'bigint' && n >= 0n && n < 1n << BigInt(bits)
const bytes32 = (x) => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x)
const eq = (a, b) => a?.toLowerCase() === b?.toLowerCase()
export const initialFunding = () => ({ batch: 0n, step: 0n, root: ZERO, totals: [0n, 0n], blind: ZERO })
export function fundingRoot(dep, owner, f) {
  if (!uint(f.batch, 64) || !uint(f.step, 7) || f.step > 64n || !Array.isArray(f.totals) || f.totals.length !== 2 || !f.totals.every((n) => uint(n, 134)) || !bytes32(f.blind)) throw new Error('invalid private funding opening')
  if (f.step === 0n) {
    if (f.totals.some((n) => n !== 0n) || !eq(f.blind, ZERO)) throw new Error('initial funding state must be zero')
    return ZERO
  }
  return keccak256(encodeAbiParameters(
    ['uint256', 'address', 'address', 'uint256', 'uint256', 'uint256', 'bytes32', 'uint256'].map((type) => ({ type })),
    [BigInt(dep.chainId), dep.settlement, owner, f.batch, ...f.totals, f.blind, f.step],
  ))
}
export function validateFunding(dep, owner, f) {
  if (!f || !bytes32(f.root) || !eq(fundingRoot(dep, owner, f), f.root)) throw new Error('private funding opening does not match its root; restore a current export')
  return f
}
const matches = (f, chain) => f.step === chain.step && eq(f.root, chain.root) && (chain.step === 0n || f.batch === chain.batch)
export function reconcileFunding(dep, owner, saved, chain, now) {
  const f = saved ?? initialFunding()
  validateFunding(dep, owner, f)
  if (f.pending) {
    validateFunding(dep, owner, f.pending.next)
    if (f.pending.next.step !== f.step + 1n || (f.step > 0n && f.pending.next.batch !== f.batch) || !uint(f.pending.closes, 256)) throw new Error('invalid pending funding transition')
    if (matches(f.pending.next, chain)) return { ...f.pending.next }
    if (!matches(f, chain) && chain.step !== 0n) throw new Error('chain funding state differs from the pending transition; restore a current export')
    // Once the original commit window has closed it cannot subsequently append. A zero chain state
    // can also mean it was accepted and already closed; in either case the next opening is zero.
    if (now >= f.pending.closes) {
      if (chain.step === 0n) return initialFunding()
      if (matches(f, chain)) { const { pending, ...previous } = f; return previous }
    }
    throw new Error('an admission submission is pending; run resume-admission before another order')
  }
  if (chain.step === 0n) return initialFunding()
  if (!matches(f, chain)) throw new Error('private funding state is stale or missing; restore a current export')
  return f
}
export function nextFunding(dep, owner, f, batch, order, blind) {
  validateFunding(dep, owner, f)
  if (f.pending) throw new Error('an admission submission is pending')
  if (f.step >= 64n || (f.step > 0n && f.batch !== batch)) throw new Error('close the active batch before appending')
  const totals = [...f.totals]
  totals[order.zeroForOne ? 0 : 1] += order.amountIn
  const next = { batch, step: f.step + 1n, totals, blind }
  next.root = fundingRoot(dep, owner, next)
  return next
}

/** Restore an unresolved transition only when its previous opening still matches chain state. */
export function restoreFunding(dep, owner, saved, chain, now) {
  try { return reconcileFunding(dep, owner, saved, chain, now) }
  catch (e) {
    if (e.message.includes('run resume-admission') && saved?.pending && matches(saved, chain)) return saved
    throw e
  }
}
