// Pure logic for the demo bots: sandwich sizing on a full-range v4 pool, and coverage priced from a tx's slippage.

const Q96 = 2n ** 96n
const FEE_UNITS = 1_000_000n

/** Exact-input output of a constant-product pool; the fee is taken from the input, as in v4. */
export function amountOut(reserveIn, reserveOut, amountIn, fee) {
  const net = (amountIn * (FEE_UNITS - BigInt(fee))) / FEE_UNITS
  return { out: (reserveOut * net) / (reserveIn + net), net }
}

/**
 * Sizes a sandwich on a pool with only full-range liquidity (a constant-product curve with virtual reserves
 * L·Q96/√P and L·√P/Q96): the largest front leg, up to `maxFront`, that still lets the victim clear `minOut`
 * (plus `marginBps` for rounding), then a back leg that sells everything the front bought.
 * @returns null when no front leg fits or the round trip would not profit
 */
export function planSandwich({ sqrtPriceX96, liquidity, fee, zeroForOne, victimIn, minOut, maxFront, marginBps = 10n }) {
  const x = (liquidity * Q96) / sqrtPriceX96
  const y = (liquidity * sqrtPriceX96) / Q96
  const [rIn, rOut] = zeroForOne ? [x, y] : [y, x]
  const need = (minOut * (10_000n + marginBps)) / 10_000n
  const victimAfter = (front) => {
    const f = amountOut(rIn, rOut, front, fee)
    return amountOut(rIn + f.net, rOut - f.out, victimIn, fee).out
  }
  let lo = 0n
  let hi = maxFront
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n
    if (victimAfter(mid) >= need) lo = mid
    else hi = mid - 1n
  }
  if (lo === 0n) return null
  const f = amountOut(rIn, rOut, lo, fee)
  const v = amountOut(rIn + f.net, rOut - f.out, victimIn, fee)
  const back = amountOut(rOut - f.out - v.out, rIn + f.net + v.net, f.out, fee)
  if (back.out <= lo) return null
  return { frontIn: lo, bought: f.out, victimOut: v.out, backOut: back.out, profit: back.out - lo }
}

/**
 * Coverage from the tx's own slippage, in its input token: the share of `amountIn` the user agreed to lose,
 * `amountIn · (quoteOut − minOut) / quoteOut`, with `quoteOut` what the tx would receive at acceptance.
 */
export function maxPayoutFor(amountIn, quoteOut, minOut) {
  return quoteOut > minOut ? (amountIn * (quoteOut - minOut)) / quoteOut : 0n
}

/** BondRegistry's EIP-712 receipt (PROTECTED_TYPEHASH, receiptDigest). */
export const receiptTypes = {
  Protected: [
    { name: 'txHash', type: 'bytes32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'acceptedAt', type: 'uint64' },
    { name: 'maxBlock', type: 'uint64' },
    { name: 'maxPayout', type: 'uint256' },
    { name: 'beneficiary', type: 'address' },
  ],
}
export const receiptDomain = (chainId, registry) => ({ name: 'BondRegistry', version: '1', chainId, verifyingContract: registry })
