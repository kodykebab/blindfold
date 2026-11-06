// Demo wallets: 4 role wallets + VICTIMS (5) traders, all from DEMO_MNEMONIC.
//   npm run wallets -- new              make a fresh mnemonic and write it to .env (refuses to overwrite)
//   npm run wallets -- list             addresses and balances
//   npm run wallets -- fund [ethEach]   the deployer tops every other wallet up to ethEach (default FUND_ETH or 0.01)
// Fund the deployer from a faucet first; it pays for deploys, the pool's liquidity and the sniper's capital.
import { existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { formatEther, parseEther } from 'viem'
import { english, generateMnemonic } from 'viem/accounts'

const ENV_FILE = fileURLToPath(new URL('.env', import.meta.url))
const [cmd, arg] = process.argv.slice(2)
// `new` runs offline; everything else needs the chain, which common.mjs connects to on import
const { E, ROLES, allWallets, account, eth, mined, pub, wallet } = cmd === 'new' ? {} : await import('./common.mjs')

async function list() {
  for (const w of allWallets()) {
    console.log(`${w.role.padEnd(9)} #${String(w.index).padEnd(3)} ${w.account.address}  ${eth(await pub.getBalance({ address: w.account.address }))}`)
  }
}

async function fund(each = E.FUND_ETH || '0.01') {
  const target = parseEther(each)
  const from = account(ROLES.deployer)
  // the sniper needs its capital on top of gas: deploy.mjs funds its contract from the sniper's wallet
  const extra = { sniper: parseEther(E.BOT_ETH || '0.02') }
  for (const w of allWallets().filter((w) => w.role !== 'deployer')) {
    const want = target + (extra[w.role] ?? 0n)
    const have = await pub.getBalance({ address: w.account.address })
    if (have >= want) continue
    await mined(await wallet(from).sendTransaction({ to: w.account.address, value: want - have }))
    console.log(`funded ${w.role} ${w.account.address} +${formatEther(want - have)} ETH`)
  }
  await list()
}

function create() {
  if (existsSync(ENV_FILE) && !process.argv.includes('--force')) throw new Error(`${ENV_FILE} exists; pass --force to replace it`)
  writeFileSync(ENV_FILE, `DEMO_MNEMONIC="${generateMnemonic(english)}"\n`, { mode: 0o600 })
  console.log(`wrote ${ENV_FILE}. Fund the deployer, then run \`npm run wallets -- fund\`.`)
}

const commands = { new: create, list, fund: () => fund(arg) }
if (!commands[cmd]) {
  console.error(`usage: npm run wallets -- ${Object.keys(commands).join(' | ')}`)
  process.exit(2)
}
await commands[cmd]()

process.exit(0) // close RPC keep-alive sockets after the command completes
