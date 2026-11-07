// npm start: the stack for manual checks (C1, C6): anvil on 8563 with the contracts deployed, test tokens for one
// address, and the bridge on http://localhost:4317. MINT_TO picks the address (default: anvil account 10).
import { parseEther } from 'viem'
import { startChain, user } from './chain.mjs'
import { startBridge, BRIDGE } from './browser.mjs'

const c = await startChain()
const to = process.env.MINT_TO || user(10).address
for (const t of [c.dep.token0, c.dep.token1]) await c.mint(to, t, parseEther('1000'))
await startBridge()
console.log(`anvil   ${c.dep.rpc} (chain 31337)\nbridge  ${BRIDGE}/\ndeploy  ${c.depFile}\nminted  1000 TKA and 1000 TKB to ${to}`)
process.on('SIGINT', async () => { await c.stop(); process.exit(0) })
