// Pure shaping for `status --json`, plus the pool price, liquidity and gas samples that object carries.
import { BaseError, ContractFunctionRevertedError, formatUnits } from 'viem'

const Q96 = 1n << 96n

/** symbol() is whatever the token deployer returns. Empty or non-printable falls back to the address. */
export function cleanSymbol(raw, address) {
  const fallback = typeof address === 'string' ? address : ''
  if (typeof raw !== 'string') return fallback
  const stripped = raw.replace(/[\u0000-\u001F\u007F]/g, '')
  if (!stripped) return fallback
  return stripped.slice(0, 32)
}

function amount(value, decimals) {
  return formatUnits(BigInt(value), Number(decimals))
}

/**
 * One status object. Amounts stay decimal strings from `formatUnits`.
 * `rows` are vaultView rows: { tok, wallet, available, reserved, withdrawable } in base units.
 */
export function statusPayload({ account, chainId, token0, token1, rows, openCommitments, batchId, now, deadlines, preparation, quote }) {
  const side = (token, role) => ({ address: token.address, symbol: token.symbol, decimals: Number(token.decimals), role })
  const names = [side(token0, 'token0'), side(token1, 'token1')]
  return {
    account,
    chainId: Number(chainId),
    pair: { token0: names[0], token1: names[1] },
    balances: rows.map((row, index) => ({
      token: names[index].role,
      wallet: amount(row.wallet, row.tok.decimals),
      available: amount(row.available, row.tok.decimals),
      reserved: amount(row.reserved, row.tok.decimals),
      withdrawable: amount(row.withdrawable, row.tok.decimals),
    })),
    openCommitments: Number(openCommitments),
    batch: {
      id: String(batchId),
      now: Number(now),
      deadlines: deadlines.map((d) => ({ at: Number(d.at), what: d.what })),
    },
    preparation: preparation ?? 'none',
    quote: quote ?? null,
  }
}

/** Human token1 per token0. `priceX96` is raw token1 per raw token0, scaled by 2^96. Truncates toward zero at `scale` decimals. */
export function priceFromX96(priceX96, decimals0, decimals1, scale = 18) {
  const px = BigInt(priceX96)
  const places = BigInt(scale)
  const scaled = px * (10n ** BigInt(decimals0)) * (10n ** places) / (Q96 * (10n ** BigInt(decimals1)))
  const base = 10n ** places
  const whole = scaled / base
  const frac = (scaled % base).toString().padStart(Number(places), '0').replace(/0+$/, '')
  return frac ? `${whole.toString()}.${frac}` : whole.toString()
}

export function revertReason(error) {
  const revert = error instanceof BaseError ? error.walk((item) => item instanceof ContractFunctionRevertedError) : null
  return revert?.data?.errorName || error?.shortMessage || error?.message || 'read failed'
}

function sample(block, source, body) {
  return { source, blockNumber: block.number.toString(), at: Number(block.timestamp), ...body }
}

/** Pool price, external reference and raw v4 liquidity. A revert becomes `price: null` with the reason. */
export async function readQuote({ read, has, batchId, decimals0, decimals1, block }) {
  const take = async (name, args, source) => {
    try {
      const priceX96 = await read(name, args)
      return sample(block, source, { price: priceFromX96(priceX96, decimals0, decimals1), priceX96: priceX96.toString() })
    } catch (error) {
      return sample(block, source, { price: null, reason: revertReason(error) })
    }
  }
  const pool = await take('poolPriceX96', [], 'BlindfoldSettlement.poolPriceX96')
  const external = has('referencePriceX96')
    ? await take('referencePriceX96', [batchId], 'BlindfoldSettlement.referencePriceX96')
    : null
  let liquidity
  try {
    const raw = await read('poolLiquidity', [])
    liquidity = sample(block, 'BlindfoldSettlement.poolLiquidity', {
      raw: raw.toString(),
      label: 'pool liquidity (v4 units)',
      estimate: null,
      estimateReason: 'estimate not available',
    })
  } catch (error) {
    liquidity = sample(block, 'BlindfoldSettlement.poolLiquidity', {
      raw: null,
      reason: revertReason(error),
      label: 'pool liquidity (v4 units)',
      estimate: null,
      estimateReason: 'estimate not available',
    })
  }
  return { pool, external, liquidity }
}

/** `units * gasPrice` in ETH. A missing estimate stays null and keeps the reason. */
export function gasQuote({ units, gasPrice, block, reason }) {
  const row = sample(block, 'estimateContractGas(commit) * eth_gasPrice', {})
  if (reason) return { ...row, eth: null, units: null, reason }
  const wei = BigInt(units) * BigInt(gasPrice)
  return { ...row, eth: formatUnits(wei, 18), units: BigInt(units).toString(), wei: wei.toString() }
}
