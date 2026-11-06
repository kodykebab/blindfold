// Pure shaping for `status --json`. Price, liquidity and gas land in the same object.
import { formatUnits } from 'viem'

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
