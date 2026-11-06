// One readable sentence for a failed call. An unreachable RPC names only its origin: URLs often carry an API key.
export function rpcOrigin(url) {
  try { return new URL(url).origin } catch { return 'the configured RPC' }
}

export function errorText(e, rpc = process.env.RPC_URL || 'http://127.0.0.1:8545') {
  const text = `${e?.shortMessage ?? e?.message ?? e}`
  const details = `${e?.details ?? ''} ${e?.cause?.message ?? ''} ${e?.cause?.code ?? ''}`
  if (e?.name === 'HttpRequestError' || /HTTP request failed|fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(text + details)) {
    return `cannot reach the RPC at ${rpcOrigin(rpc)}; check that the node is running and RPC_URL points at it`
  }
  if (e?.name === 'TimeoutError' || /took too long to respond|timed out/i.test(text)) return `the RPC at ${rpcOrigin(rpc)} did not answer in time; try again`
  return text
}
