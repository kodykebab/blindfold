// A process-owned, proof-enforced local stack. It never connects to an existing chain or uses real keys.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../packages/solver/package.json', import.meta.url))
const { createPublicClient, createWalletClient, defineChain, getCreate2Address, http, toHex } = require('viem')
const { mnemonicToAccount } = require('viem/accounts')
const { artifactPath } = await import('../packages/solver/artifacts.mjs')
const { stackHealth, formatHealth, readJsonFile } = await import('./stack-health.mjs')
const params = process.env.ADMISSION_PARAMS, prover = process.env.ADMISSION_PROVER
if (!params || !prover) throw Error('Set ADMISSION_PARAMS and ADMISSION_PROVER to the prepared local development artifacts')
const manifest = JSON.parse(readFileSync(join(params, 'manifest.json'), 'utf8'))
if (manifest.developmentOnly !== true) throw Error('The local development stack requires explicitly marked development parameters')
const manifestSha256 = createHash('sha256').update(readFileSync(join(params, 'manifest.json'))).digest('hex')
for (const mode of ['preparation', 'online']) {
  const name = `${mode}.sol`
  const actual = createHash('sha256').update(readFileSync(join(params, name))).digest('hex')
  if (manifest.files?.[name] !== actual) throw Error(`Development verifier source ${name} does not match the parameter manifest`)
}
const out = process.env.CONTRACTS_OUT || join(root, 'contracts/out')
const verifierOut = process.env.ADMISSION_VERIFIER_OUT || join(params, 'out')
const art = (name) => JSON.parse(readFileSync(artifactPath(out, name), 'utf8'))
const mnemonic = 'test test test test test test test test test test test junk'
const user = (i) => mnemonicToAccount(mnemonic, { addressIndex: i })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function freePort() {
  const server = createServer().listen(0, '127.0.0.1'); await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port
}
const children = []
function launch(program, args, options = {}) {
  const child = spawn(program, args, options); children.push(child); return child
}
function stop() { for (const child of children) if (child.exitCode === null) child.kill('SIGTERM') }
process.once('SIGINT', () => { stop(); process.exit(0) })
process.once('SIGTERM', () => { stop(); process.exit(0) })
try {
  const rpcPort = await freePort()
  let webPort = await freePort()
  while (webPort === rpcPort) webPort = await freePort()
  const rpc = `http://127.0.0.1:${rpcPort}`, url = `http://127.0.0.1:${webPort}`
  const dir = mkdtempSync(join(tmpdir(), 'blindfold-dev-'))
  const anvil = launch('anvil', ['--silent', '--port', String(rpcPort), '--accounts', '20', '--gas-limit', '300000000', '--block-time', '1', '--mixed-mining'], { stdio: 'ignore' })
  const chain = defineChain({ id: 31337, name: 'Blindfold local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
  const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 100 })
  const wallet = createWalletClient({ account: user(0), chain, transport: http(rpc) })
  for (let i = 0; ; i++) { try { await pub.getChainId(); break } catch { if (anvil.exitCode !== null || i > 100) throw Error('Local Anvil did not start'); await sleep(50) } }
  const wait = async (hash) => { const receipt = await pub.waitForTransactionReceipt({ hash }); if (receipt.status !== 'success') throw Error(`local deployment reverted: ${hash}`); return receipt }
  const deployArtifact = async (artifact, args = []) => (await wait(await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args }))).contractAddress
  const deploy = (name, args = []) => deployArtifact(art(name), args)
  const write = async (address, name, functionName, args = []) => wait(await wallet.writeContract({ address, abi: art(name).abi, functionName, args }))
  const read = (address, name, functionName, args = []) => pub.readContract({ address, abi: art(name).abi, functionName, args })
  const manager = await deploy('PoolManager', [user(0).address])
  const a = await deploy('MockERC20', ['Local token A', 'TKA', 18]), b = await deploy('MockERC20', ['Local token B', 'TKB', 18])
  const [token0, token1] = [a, b].sort((x, y) => BigInt(x) < BigInt(y) ? -1 : 1)
  const vault = await deploy('AdmissionVault', [token0, token1])
  const verifiers = []
  for (const mode of ['preparation', 'online']) verifiers.push(await deployArtifact(JSON.parse(readFileSync(join(verifierOut, `${mode}.sol`, 'Verifier.json'), 'utf8'))))
  const now = (await pub.getBlock()).timestamp, start = now - (now - 1692803367n) % 3n
  const settlement = await deploy('AdmittedSettlement', [{ manager, vault, depositToken: token1, depositAmount: 5n * 10n ** 18n, commitFee: 1n,
    bountyBps: 2000n, treasury: user(9).address, schedule: { start: Number(start), batchLength: 300, revealLength: 24, settleLength: 30 }, toleranceBps: 100n }, ...verifiers])
  await write(vault, 'BlindfoldVault', 'setOperator', [settlement])
  const factory = await deploy('AdmissionPoolFactory')
  const bytecodeHash = await read(factory, 'AdmissionPoolFactory', 'initCodeHash', [manager, settlement])
  let hooks, salt
  for (let i = 0n; i < 500000n; i++) {
    const candidate = toHex(i, { size: 32 }), address = getCreate2Address({ from: factory, salt: candidate, bytecodeHash })
    if ((BigInt(address) & 16383n) === 128n) { hooks = address; salt = candidate; break }
  }
  if (!salt) throw Error('Could not mine the local hook address')
  await write(factory, 'AdmissionPoolFactory', 'deployHook', [manager, settlement, salt])
  const key = { currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks }
  await write(manager, 'PoolManager', 'initialize', [key, 1n << 96n])
  await write(settlement, 'AdmittedSettlement', 'initialize', [key])
  const lp = await deploy('PoolModifyLiquidityTest', [manager])
  for (const token of [token0, token1]) {
    await write(token, 'MockERC20', 'mint', [user(0).address, 10n ** 30n])
    await write(token, 'MockERC20', 'approve', [lp, (1n << 256n) - 1n])
    await write(token, 'MockERC20', 'mint', [user(10).address, 100n * 10n ** 18n])
  }
  await write(lp, 'PoolModifyLiquidityTest', 'modifyLiquidity', [key, { tickLower: -60000, tickUpper: 60000, liquidityDelta: 10n ** 22n, salt: toHex(0n, { size: 32 }) }, '0x'])
  const deployment = join(dir, 'blindfold.local.json')
  writeFileSync(deployment, JSON.stringify({ chainId: 31337, deployBlock: 0, mode: 'local', rpc, vault, settlement, token0, token1, depositToken: token1,
    admission: { manifestSha256, preparationVerifier: verifiers[0], onlineVerifier: verifiers[1] } }, null, 2), { mode: 0o600 })
  const env = { ...process.env, RPC_URL: rpc, DEPLOYMENTS: deployment, CONTRACTS_OUT: out, ADMISSION_PARAMS: params, ADMISSION_PROVER: prover,
    PRIVATE_KEY: '', SOLVER_KEY: '', KEEPER_KEY: '', KEEPER_INDEX: '1', KEEPER_STATUS: join(dir, 'keeper-status.json'),
    KEEPER_BUDGET_WEI: '1000000000000000000', KEEPER_MIN_BALANCE_WEI: '1000000000000000', MNEMONIC: mnemonic, DRAND: '', CLIENT_ACCOUNT_INDEX: '10', CLIENT_STATE: join(dir, 'state'),
    SETTLEMENT_ARTIFACT: artifactPath(out, 'AdmittedSettlement'), PORT: String(webPort), OFFLINE: '', ADMISSION_MIN_LEAD_SECONDS: '120', STACK_HEALTH: join(dir, 'health.json') }
  const web = launch(process.execPath, ['server.mjs'], { cwd: join(root, 'app/haveibeensandwiched'), env, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve, reject) => { web.stdout.once('data', resolve); web.once('error', reject); web.once('exit', (code) => reject(Error(`web service exited (${code})`))) })
  web.stdout.pipe(process.stdout)
  const keeper = launch(process.execPath, ['packages/keeper/keeper.mjs'], { cwd: root, env, stdio: 'inherit' })
  const solver = launch(process.execPath, ['packages/solver/solver.mjs', '--json'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] })
  let solverStatus = null, pending = ''
  solver.stdout.on('data', (chunk) => {
    process.stdout.write(chunk)
    const lines = (pending + chunk).split('\n'); pending = lines.pop()
    for (const line of lines) { try { const value = JSON.parse(line); if (value.solver) solverStatus = value } catch {} }
  })
  for (const [name, child] of [['anvil', anvil], ['web', web], ['keeper', keeper], ['solver', solver]]) {
    child.once('exit', (code) => { console.error(`${name} exited (${code}); stopping the local stack`); stop(); process.exitCode = 1 })
    child.once('error', (error) => { console.error(`${name}: ${error.message}`); stop(); process.exitCode = 1 })
  }
  await sleep(500)
  if ([anvil, web, keeper, solver].some((child) => child.exitCode !== null)) throw Error('A local service stopped during startup')
  // Service health for the terminal and the page (STACK_HEALTH); printed again whenever a service goes down or recovers.
  const health = () => stackHealth({ pub, dep: JSON.parse(readFileSync(deployment, 'utf8')), prover,
    keeper: { child: keeper, status: readJsonFile(env.KEEPER_STATUS) }, solver: { child: solver, status: solverStatus } })
  let shown = null
  const report = async () => {
    const h = await health()
    writeFileSync(env.STACK_HEALTH, JSON.stringify(h, null, 2), { mode: 0o600 })
    const down = Object.entries(h.services).filter(([, s]) => !s.ok).map(([name]) => name).join(',')
    if (down !== shown) { shown = down; console.log(`stack health:\n${formatHealth(h)}`) }
  }
  await report()
  setInterval(() => report().catch((e) => console.error(`stack health: ${e.message}`)), 3000).unref()
  console.log(`LOCAL_WEB_URL=${url}/trade`)
  console.log(`Service health: ${env.STACK_HEALTH}`)
  console.log(`Local deployment and private state: ${dir}`)
  console.log('Proof-enforced development chain 31337; Anvil test accounts and local test tokens only. Ctrl-C stops this stack.')
} catch (error) { stop(); console.error(`local stack: ${error.message}`); process.exitCode = 1 }
