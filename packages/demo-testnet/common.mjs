// Shared config for the testnet demo: chain, wallets by role, artifacts, deployments files.
// Every wallet comes from one mnemonic (DEMO_MNEMONIC in packages/demo-testnet/.env, made by `npm run wallets -- new`).
// Indexes follow PLAN.md's anvil roles so the client, keeper and solver CLIs can use the same MNEMONIC.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, defineChain, formatEther, http } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'

export const here = (p) => fileURLToPath(new URL(p, import.meta.url))
export const root = (p) => here(`../../${p}`)
export const ENV_FILE = here('.env')

// .env is KEY=VALUE lines; real process env wins
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
export const E = process.env
// viem errors run to hundreds of lines; the short message is what matters in a demo terminal
process.on('uncaughtException', (e) => {
  console.error(`error: ${e.shortMessage ?? e.message}${e.details ? ` (${e.details})` : ''}`)
  process.exit(1)
})
// Unichain Sepolia: 1 s blocks, cheap gas, ordered by priority fee
export const RPC_URL = E.RPC_URL || 'https://sepolia.unichain.org'
export const MEMPOOL_PORT = Number(E.MEMPOOL_PORT || 8546)
export const MEMPOOL_URL = E.MEMPOOL_URL || `http://127.0.0.1:${MEMPOOL_PORT}`
export const MNEMONIC = E.DEMO_MNEMONIC || E.MNEMONIC
export const SANDWICH_FILE = E.SANDWICH_DEPLOYMENTS || root('deployments/demo.testnet.json')
export const BLINDFOLD_FILE = E.DEPLOYMENTS || root('deployments/blindfold.testnet.json')

export const ROLES = { deployer: 0, keeper: 1, solver: 2, sniper: 5 }
export const VICTIMS = Number(E.VICTIMS || 5)
export const victimIndex = (i) => 10 + i
export function account(index) {
  if (!MNEMONIC) throw new Error('no DEMO_MNEMONIC: run `npm run wallets -- new` first')
  return mnemonicToAccount(MNEMONIC, { addressIndex: index })
}
export const allWallets = () => [
  ...Object.entries(ROLES).map(([role, i]) => ({ role, index: i, account: account(i) })),
  ...Array.from({ length: VICTIMS }, (_, i) => ({ role: `victim${i + 1}`, index: victimIndex(i), account: account(victimIndex(i)) })),
]

export const pub = createPublicClient({ transport: http(RPC_URL), pollingInterval: 500 })
export const chain = defineChain({
  id: await pub.getChainId(), name: 'demo', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
})
export const wallet = (acct, url = RPC_URL) => createWalletClient({ account: acct, chain, transport: http(url) })

export const readJson = (path, hint) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (e) {
    throw new Error(`can't read ${path} (${e.code ?? e.message}). ${hint}`)
  }
}
/** contracts/out/<file>/<name>.json, or <name>.<solc>.json when forge compiled the file under two solc versions. */
export function artifact(file, name) {
  const dir = root(`contracts/out/${file}`)
  let f = `${name}.json`
  try {
    f = readdirSync(dir).find((n) => n === f || (n.startsWith(`${name}.`) && n.endsWith('.json'))) ?? f
  } catch {}
  return readJson(`${dir}/${f}`, 'Run `forge build` in contracts/.')
}

export async function mined(hash) {
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (rc.status !== 'success') throw new Error(`tx ${hash} reverted`)
  return rc
}
export const same = (a, b) => a?.toLowerCase() === b?.toLowerCase()
export const eth = (wei) => `${formatEther(wei)} ETH`
export { poolIdOf } from './lib.mjs'
