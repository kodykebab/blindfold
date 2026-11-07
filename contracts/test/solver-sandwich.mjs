// SEC-01 local fork experiment: the UNCHANGED solver CLI (packages/solver/solver.mjs) settling a one-sided batch
// through the real Uniswap v3 USDC/WETH 500-fee pool, with and without an intervening same-direction swap.
//
//   source env.sh && forge build --root contracts
//   ETH_FORK_BLOCK=<block> node contracts/test/solver-sandwich.mjs 2>&1 | tee /tmp/blindfold-solver-sandwich-run.log
//
// Isolated anvil fork only: public RPC is read through anvil's fork backend; every transaction goes to the local
// node. Anvil's public test mnemonic: account 0 user/admin, 1 attacker, 2 solver (PLAN.md roles).
// A logging JSON-RPC proxy sits between the CLI and anvil so every simulation the CLI performs is recorded without
// modifying solver code. Block timestamps advance exactly 1 s per block, so identical sequences reproduce state.
//
// Env: ETH_RPC, ETH_FORK_BLOCK (default latest-3; record it), SANDWICH_OUT (results JSON path),
//      SANDWICH_QUICK=1 (one case, two front sizes), SANDWICH_CASES=id,id (subset).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import http from 'node:http'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { artifactPath } from '../../packages/solver/artifacts.mjs'
import { Q96, json, quoteOut, bps, priceOffsetBps, classifyCli, attackAccounting, weiToToken0, summarise } from './solver-sandwich-lib.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(join(root, 'packages/solver/package.json'))
const viem = require('viem')
const { createPublicClient, createWalletClient, defineChain, http: httpTransport, getCreate2Address, toHex, parseAbi,
  parseEventLogs, decodeFunctionData, decodeErrorResult, keccak256, encodeAbiParameters, TransactionReceiptNotFoundError } = viem
const { mnemonicToAccount } = require('viem/accounts')

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640' // USDC/WETH 0.05%, token0 USDC, token1 WETH
const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984'
const USDC_BALANCE_SLOT = 9n // FiatTokenV2_2 balanceAndBlacklistStates; verified by balanceOf after writing
const DRAND_GENESIS = 1692803367n
// Same market/auction configuration as ExternalEthereumForkTest / E1 for comparability.
const MARKET = { window: 600, maxDelay: 30, maxObservationAge: 120, minHarmonicLiquidity: 10n ** 15n, maxDeviationBps: 100n }
const SCHEDULE = { batchLength: 30, revealLength: 24, settleLength: 30 }
const OUT = process.env.SANDWICH_OUT || '/tmp/blindfold-solver-sandwich-results.json'
const QUICK = process.env.SANDWICH_QUICK === '1'
const FRONT_UNITS = QUICK ? [10n, 100n] : [1n, 2n, 5n, 10n, 20n, 50n, 100n, 200n, 500n] // E1 grid
const ALL_CASES = [
  // E1 sizes: "small" 30,000 USDC / 10 WETH, "large" 90,000 USDC / 40 WETH. Fronts in the victim's input token.
  { id: 'usdc-30k', sell: true, amount: 30_000n * 10n ** 6n, unit: 3000n * 10n ** 6n },
  { id: 'weth-10', sell: false, amount: 10n * 10n ** 18n, unit: 10n ** 18n },
  { id: 'usdc-90k', sell: true, amount: 90_000n * 10n ** 6n, unit: 3000n * 10n ** 6n },
  { id: 'weth-40', sell: false, amount: 40n * 10n ** 18n, unit: 10n ** 18n },
  // Orders too large to fill fully inside the 1% band: exercises the CLI's proportional partial-fill search.
  { id: 'usdc-3m-partial', sell: true, amount: 3_000_000n * 10n ** 6n, unit: 3000n * 10n ** 6n, fronts: [5n, 50n, 200n] },
  { id: 'weth-1000-partial', sell: false, amount: 1000n * 10n ** 18n, unit: 10n ** 18n, fronts: [5n, 50n, 200n] },
  // Size-aware user limits: minAmountOut = simulated pool output at commit time minus `limitBps` (existing contract
  // limit, no new mechanism). Measures what a tighter client-side slippage setting protects and what it costs.
  ...[10, 25].flatMap((limitBps) => [
    { id: `usdc-90k-limit${limitBps}`, sell: true, amount: 90_000n * 10n ** 6n, unit: 3000n * 10n ** 6n, limitBps, fronts: [1n, 2n, 5n, 10n, 20n, 50n, 100n] },
    { id: `weth-40-limit${limitBps}`, sell: false, amount: 40n * 10n ** 18n, unit: 10n ** 18n, limitBps, fronts: [1n, 2n, 5n, 10n, 20n, 50n, 100n] },
  ]),
]
const only = process.env.SANDWICH_CASES?.split(',')
const CASES = QUICK ? ALL_CASES.slice(0, 1) : only ? ALL_CASES.filter((c) => only.includes(c.id)) : ALL_CASES

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
const tool = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).split('\n')[0].trim() } catch (e) { return `unavailable: ${e.message}` } }
const freePort = async () => {
  const l = createServer(); await new Promise((r) => l.listen(0, '127.0.0.1', r))
  const p = l.address().port; await new Promise((r) => l.close(r)); return p
}
const log = (...a) => console.log(new Date().toISOString(), ...a)

// ---------------------------------------------------------------------------------------------- provenance
const out = join(root, 'contracts/out')
const load = (name) => JSON.parse(readFileSync(artifactPath(out, name)))
const USED = ['BlindfoldSettlement', 'BlindfoldVault', 'UniswapV3Market', 'SealedPoolHookFactory', 'PoolManager', 'ExternalSandwichActor']
const sourceFiles = ['packages/solver/solver.mjs', 'packages/solver/external.mjs', 'packages/solver/price.mjs', 'packages/solver/peer.mjs',
  'packages/solver/artifacts.mjs', 'packages/solver/package-lock.json', 'contracts/test/solver-sandwich.mjs', 'contracts/test/solver-sandwich-lib.mjs',
  'contracts/test/ExternalSandwichActor.sol', 'contracts/src/BlindfoldSettlement.sol', 'contracts/src/BatchAuction.sol',
  'contracts/src/BlindfoldVault.sol', 'contracts/src/market/UniswapV3Market.sol', 'contracts/foundry.toml']
const provenance = {
  commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  dirty: git('status', '--porcelain').split('\n').filter(Boolean),
  solverUnchangedFromHead: git('diff', '--name-only', 'HEAD', '--', 'packages/solver').length === 0,
  productionContractsUnchangedFromHead: git('diff', '--name-only', 'HEAD', '--', 'contracts/src').length === 0,
  files: Object.fromEntries(sourceFiles.map((f) => [f, sha256(join(root, f))])),
  tools: { node: process.version, anvil: tool('anvil', ['--version']), forge: tool('forge', ['--version']), viem: require('viem/package.json').version },
  artifacts: Object.fromEntries(USED.map((n) => {
    const a = load(n); const m = typeof a.metadata === 'string' ? JSON.parse(a.metadata) : a.metadata
    return [n, { path: artifactPath(out, n).slice(root.length), compiler: m?.compiler?.version, optimizer: m?.settings?.optimizer,
      viaIR: m?.settings?.viaIR ?? false, evmVersion: m?.settings?.evmVersion, runtimeBytes: (a.deployedBytecode.object.length - 2) / 2,
      runtimeKeccak: keccak256(a.deployedBytecode.object) }]
  })),
}
assert.ok(provenance.solverUnchangedFromHead, 'baseline requires packages/solver unchanged from HEAD')
assert.ok(provenance.productionContractsUnchangedFromHead, 'baseline requires contracts/src unchanged from HEAD')

// ---------------------------------------------------------------------------------------------- node + proxy
const externalRpc = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com'
const upstream = createPublicClient({ transport: httpTransport(externalRpc, { timeout: 30_000 }) })
const forkBlock = process.env.ETH_FORK_BLOCK ? BigInt(process.env.ETH_FORK_BLOCK) : (await upstream.getBlockNumber()) - 3n
const anvilPort = await freePort()
const anvilRpc = `http://127.0.0.1:${anvilPort}`
const directory = mkdtempSync(join(tmpdir(), 'blindfold-solver-sandwich-'))
const node = spawn('anvil', ['--silent', '--chain-id', '31337', '--port', String(anvilPort), '--fork-url', externalRpc,
  '--fork-block-number', String(forkBlock), '--fork-retry-backoff', '1000', '--retries', '10', '--timeout', '60000'], { stdio: ['ignore', 'ignore', 'pipe'] })
let nodeErrors = ''
node.stderr.on('data', (b) => { nodeErrors += b })

let recording = null // array while a CLI run is being observed
const proxy = http.createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    const r = await fetch(anvilRpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    const text = await r.text()
    if (recording) recording.push({ at: performance.now(), req: JSON.parse(body), res: JSON.parse(text) })
    res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(text)
  } catch (e) {
    if (recording) recording.push({ at: performance.now(), req: JSON.parse(body), proxyError: e.message })
    res.writeHead(502); res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: `proxy: ${e.message}` } }))
  }
})
const proxyPort = await freePort()
await new Promise((r) => proxy.listen(proxyPort, '127.0.0.1', r))
const proxyRpc = `http://127.0.0.1:${proxyPort}`

const chain = defineChain({ id: 31337, name: 'isolated-fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [anvilRpc] } } })
const transport = httpTransport(anvilRpc, { timeout: 120_000, retryCount: 0 })
const pub = createPublicClient({ chain, transport, pollingInterval: 20 })
const mnemonic = 'test test test test test test test test test test test junk'
const user = mnemonicToAccount(mnemonic)
const attacker = mnemonicToAccount(mnemonic, { addressIndex: 1 })
const solver = mnemonicToAccount(mnemonic, { addressIndex: 2 })
const wallets = Object.fromEntries([['user', user], ['attacker', attacker], ['solver', solver]].map(([k, a]) => [k, createWalletClient({ account: a, chain, transport })]))

const erc = parseAbi(['function deposit() payable', 'function approve(address,uint256) returns(bool)', 'function transfer(address,uint256) returns(bool)', 'function balanceOf(address) view returns(uint256)'])
const poolAbi = parseAbi(['function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function liquidity() view returns(uint128)', 'function fee() view returns(uint24)'])
const S = load('BlindfoldSettlement'), V = load('BlindfoldVault'), M = load('UniswapV3Market'), A = load('ExternalSandwichActor')
const errorAbi = [...S.abi, ...M.abi, ...V.abi].filter((x) => x.type === 'error')

const receipt = async (hash) => {
  for (let i = 0; i < 3000; i++) {
    try { return await pub.getTransactionReceipt({ hash }) } catch (e) { if (!(e instanceof TransactionReceiptNotFoundError)) throw e; await sleep(20) }
  }
  throw Error(`receipt timeout ${hash}`)
}
const sendAs = async (who, address, abi, functionName, args = [], { value = 0n, expect = 'success', gas = 25_000_000n } = {}) => {
  const r = await receipt(await wallets[who].writeContract({ address, abi, functionName, args, value, gas }))
  if (expect) assert.equal(r.status, expect, `${who} ${functionName}`)
  return r
}
const deploy = async (name, args = []) => {
  const a = load(name)
  const r = await receipt(await wallets.user.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, gas: 25_000_000n }))
  assert.equal(r.status, 'success', `deploy ${name}`)
  return r.contractAddress
}
const rd = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args })
const balance = (token, who) => rd(token, erc, 'balanceOf', [who])
const rpc = (method, params = []) => pub.request({ method, params })
const snapshots = new Map()
const mark = async (name) => snapshots.set(name, await rpc('evm_snapshot'))
// anvil deletes a snapshot (and later ones) on revert; take it again so it can be reused.
const rewind = async (name) => { assert.equal(await rpc('evm_revert', [snapshots.get(name)]), true, `revert ${name}`); await mark(name) }
const warp = async (t) => { await rpc('evm_setNextBlockTimestamp', [Number(t)]); await rpc('evm_mine') }
const latest = () => pub.getBlock()
const spotX96 = async () => { const [s] = await rd(POOL, poolAbi, 'slot0'); return s * s / Q96 }
const errorName = (data) => { try { return decodeErrorResult({ abi: errorAbi, data }).errorName } catch { return data && data !== '0x' ? `unknown:${data.slice(0, 10)}` : 'empty-revert' } }

const results = { experiment: 'SEC-01 actual solver CLI under intervening same-pool swaps', startedAt: new Date().toISOString(), provenance,
  fork: { rpc: externalRpc.replace(/\/\/([^/]*@)/, '//***@'), block: forkBlock }, configuration: { market: MARKET, schedule: SCHEDULE, toleranceBps: 100n,
    depositToken: USDC, depositAmount: 10n ** 6n, bountyBps: 0n, commitFee: 0n, pool: POOL, sealedPool: 'no liquidity (external route only)' },
  controls: [], cases: [], rows: [] }
const save = () => { results.summary = summarise(results.rows); writeFileSync(OUT, json(results)) }

// ---------------------------------------------------------------------------------------------- solver CLI
function decodeSimulations(entries, settlement) {
  const sims = []
  for (const { req, res, proxyError } of entries) {
    for (const [i, q] of (Array.isArray(req) ? req : [req]).entries()) {
      if (q.method !== 'eth_call' || q.params?.[0]?.to?.toLowerCase() !== settlement.toLowerCase()) continue
      let call; try { call = decodeFunctionData({ abi: S.abi, data: q.params[0].data ?? q.params[0].input }) } catch { continue }
      if (!/^settle/.test(call.functionName)) continue
      const r = Array.isArray(res) ? res[i] : res
      sims.push({ fn: call.functionName, priceX96: call.functionName === 'settlePeer' ? null : call.args[1], marginal: call.args.length > 2 ? { id: call.args.at(-2), amountIn: call.args.at(-1) } : null,
        block: q.params[1] ?? 'latest', ok: !proxyError && !r?.error, error: proxyError ? `proxy:${proxyError}` : r?.error ? errorName(r.error.data) : null })
    }
  }
  return sims
}
async function runCli(deployment, settlement, label) {
  const before = await latest()
  recording = []
  const started = performance.now()
  const child = spawn(process.execPath, [join(root, 'packages/solver/solver.mjs'), '--once'], { env: { ...process.env, RPC_URL: proxyRpc, DEPLOYMENTS: deployment,
    SETTLEMENT_ARTIFACT: artifactPath(out, 'BlindfoldSettlement'), MNEMONIC: mnemonic, SOLVER_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', (b) => { stdout += b }); child.stderr.on('data', (b) => { stderr += b })
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  const code = await new Promise((r, j) => { child.on('error', j); child.on('close', r) })
  clearTimeout(timer)
  const wallMs = Math.round(performance.now() - started)
  const entries = recording; recording = null
  const sims = decodeSimulations(entries, settlement)
  const rpcErrors = entries.filter((e) => e.proxyError || (e.res?.error && !/revert/i.test(e.res.error.message ?? ''))).map((e) => ({ method: e.req.method, error: e.proxyError ?? e.res.error.message }))
  const r = { label, code, outcome: classifyCli({ code, stdout, stderr }), stdout: stdout.trim(), stderr: stderr.trim(), wallMs,
    inputSnapshot: { block: before.number, hash: before.hash, timestamp: before.timestamp, spotX96: await spotX96() },
    rpcRequests: entries.length, simulations: sims.length, simulationErrors: Object.entries(sims.reduce((m, s) => (s.error && (m[s.error] = (m[s.error] ?? 0) + 1), m), {})),
    firstSimulation: sims[0] ?? null, lastSimulation: sims.at(-1) ?? null, rpcErrors }
  if (r.outcome === 'other-failure' && rpcErrors.length) r.outcome = 'rpc-failure'
  const selector = stderr.match(/signature:\s*(0x[0-9a-fA-F]{8})/)?.[1]
  if (selector) r.revertSelector = { selector, name: errorName(selector) }
  if (code === 0) {
    const hash = stdout.match(/tx (0x[a-fA-F0-9]{64})/)?.[1]
    assert.ok(hash, stdout)
    r.receipt = await receipt(hash); r.transaction = await pub.getTransaction({ hash })
  } else if (/settle tx (0x[a-fA-F0-9]{64}) reverted/.test(stderr)) {
    const hash = stderr.match(/settle tx (0x[a-fA-F0-9]{64})/)[1]
    r.receipt = await receipt(hash); r.transaction = await pub.getTransaction({ hash })
  }
  return r
}

// ---------------------------------------------------------------------------------------------- run
let exitCode = 0
try {
  let started = false
  for (let i = 0; i < 300; i++) {
    if (node.exitCode !== null) throw Error(`anvil exited: ${nodeErrors}`)
    try { await pub.getChainId(); started = true; break } catch { await sleep(100) }
  }
  assert.ok(started, 'anvil start')
  assert.equal(await pub.getChainId(), 31337)
  await rpc('anvil_setBlockTimestampInterval', [1])
  const forkHeader = await upstream.getBlock({ blockNumber: forkBlock })
  const [sqrt0, tick0, obsIndex, obsCard] = await rd(POOL, poolAbi, 'slot0')
  results.fork = { ...results.fork, hash: forkHeader.hash, timestamp: forkHeader.timestamp, baseFeePerGas: forkHeader.baseFeePerGas,
    pool: { sqrtPriceX96: sqrt0, tick: tick0, observationIndex: obsIndex, observationCardinality: obsCard, liquidity: await rd(POOL, poolAbi, 'liquidity'), fee: await rd(POOL, poolAbi, 'fee') } }
  log(`fork block ${forkBlock} ${forkHeader.hash} ts ${forkHeader.timestamp}; tick ${tick0}`)
  save()

  // ---- funding: ETH via anvil, WETH by deposit, USDC by writing the balance slot (checked by balanceOf).
  for (const a of [user, attacker, solver]) await rpc('anvil_setBalance', [a.address, toHex(10n ** 24n)])
  const setUsdc = async (who, amount) => {
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, USDC_BALANCE_SLOT]))
    await rpc('anvil_setStorageAt', [USDC, slot, toHex(amount, { size: 32 })]); await rpc('evm_mine')
    assert.equal(await balance(USDC, who), amount, 'USDC balance slot')
  }
  const actor = await receipt(await wallets.attacker.deployContract({ abi: A.abi, bytecode: A.bytecode.object, args: [POOL], gas: 5_000_000n })).then((r) => { assert.equal(r.status, 'success'); return r.contractAddress })
  await setUsdc(actor, 20_000_000n * 10n ** 6n)
  await sendAs('attacker', WETH, erc, 'deposit', [], { value: 5000n * 10n ** 18n })
  await sendAs('attacker', WETH, erc, 'transfer', [actor, 5000n * 10n ** 18n])
  await setUsdc(user.address, 5_000_000n * 10n ** 6n)
  await sendAs('user', WETH, erc, 'deposit', [], { value: 2000n * 10n ** 18n })

  // ---- deployment (same constructor arguments as ExternalEthereumForkTest except schedule start).
  const manager = await deploy('PoolManager', [user.address])
  const vault = await deploy('BlindfoldVault')
  const now = (await latest()).timestamp
  const start = now + 60n - (now + 60n - DRAND_GENESIS) % 3n // after the remaining deployment blocks
  const config = { manager, vault, depositToken: USDC, depositAmount: 10n ** 6n, bountyBps: 0n, treasury: user.address, commitFee: 0n,
    schedule: { start: Number(start), ...SCHEDULE }, toleranceBps: 100n }
  const settlement = await deploy('BlindfoldSettlement', [config])
  await sendAs('user', vault, V.abi, 'setOperator', [settlement])
  const factory = await deploy('SealedPoolHookFactory')
  const F = load('SealedPoolHookFactory')
  const bytecodeHash = await rd(factory, F.abi, 'initCodeHash', [manager, settlement])
  let hook, salt
  for (let i = 0n; i < 1_000_000n; i++) {
    salt = toHex(i, { size: 32 }); hook = getCreate2Address({ from: factory, salt, bytecodeHash })
    if ((BigInt(hook) & 0x3fffn) === 0x80n) break
    hook = undefined
  }
  assert.ok(hook, 'hook salt')
  await sendAs('user', factory, F.abi, 'deploy', [manager, settlement, salt])
  const key = { currency0: USDC, currency1: WETH, fee: 3000, tickSpacing: 60, hooks: hook }
  await sendAs('user', manager, load('PoolManager').abi, 'initialize', [key, sqrt0])
  await sendAs('user', settlement, S.abi, 'initialize', [key])
  const market = await deploy('UniswapV3Market', [settlement, FACTORY, POOL, MARKET.window, MARKET.maxDelay, MARKET.maxObservationAge, MARKET.minHarmonicLiquidity, MARKET.maxDeviationBps])
  await sendAs('user', settlement, S.abi, 'configureExternal', [market])
  for (const token of [USDC, WETH]) await sendAs('user', token, erc, 'approve', [vault, (1n << 256n) - 1n])
  await sendAs('user', vault, V.abi, 'deposit', [USDC, 4_000_000n * 10n ** 6n])
  await sendAs('user', vault, V.abi, 'deposit', [WETH, 1500n * 10n ** 18n])
  const deployment = join(directory, 'deployment.json')
  writeFileSync(deployment, json({ chainId: 31337, settlement }))
  results.deployment = { manager, vault, settlement, hook, market, actor, start, chainId: 31337, accounts: { user: user.address, attacker: attacker.address, solver: solver.address } }
  log(`deployed settlement ${settlement} market ${market}`)

  // ---- prewarm the fork cache with the largest swaps used later (state is reverted afterwards).
  await mark('deployed')
  for (const sell of [true, false]) {
    const unit = sell ? 3000n * 10n ** 6n : 10n ** 18n
    // cover both the largest front and the largest settlement route (partial cases search the full size first)
    const largest = CASES.filter((c) => c.sell === sell).reduce((m, c) => (c.amount > m ? c.amount : m), 500n * unit)
    await sendAs('attacker', actor, A.abi, 'trade', [sell, largest])
    const got = sell ? await balance(WETH, actor) - 5000n * 10n ** 18n : await balance(USDC, actor) - 20_000_000n * 10n ** 6n
    await sendAs('attacker', actor, A.abi, 'trade', [!sell, got])
    await rewind('deployed')
  }
  results.prewarm = 'largest front and route per direction swapped and reverted before any case'

  const vaultState = async (c) => {
    const [inT, outT] = c.sell ? [USDC, WETH] : [WETH, USDC]
    return { userIn: await rd(vault, V.abi, 'balanceOf', [user.address, inT]), userOut: await rd(vault, V.abi, 'balanceOf', [user.address, outT]),
      locked: await rd(vault, V.abi, 'lockedOf', [user.address, inT]), open: await rd(vault, V.abi, 'openCommitments', [user.address]),
      vaultIn: await balance(inT, vault), vaultOut: await balance(outT, vault), finalized: await rd(settlement, S.abi, 'finalized', [0n]),
      marketUsdc: await balance(USDC, market), marketWeth: await balance(WETH, market), settlementUsdc: await balance(USDC, settlement),
      settlementWeth: await balance(WETH, settlement), settlementVaultUsdc: await rd(vault, V.abi, 'balanceOf', [settlement, USDC]),
      settlementVaultWeth: await rd(vault, V.abi, 'balanceOf', [settlement, WETH]) }
  }
  const noStrandedBalances = (s) => {
    for (const k of ['marketUsdc', 'marketWeth', 'settlementUsdc', 'settlementWeth', 'settlementVaultUsdc', 'settlementVaultWeth']) assert.equal(s[k], 0n, k)
  }
  const checkSettled = (c, pre, post, fill) => {
    assert.equal(post.finalized, true)
    assert.ok(fill.amountIn > 0n && fill.amountIn <= c.amount)
    assert.equal(post.userIn, pre.userIn - fill.amountIn, 'user input debited by the filled amount only')
    assert.equal(post.userOut, pre.userOut + fill.amountOut, 'user credited the Filled amount')
    assert.equal(post.locked, 0n); assert.equal(post.open, 0n)
    assert.equal(pre.vaultIn - post.vaultIn, fill.amountIn, 'vault sent exactly the filled input to the route')
    assert.equal(post.vaultOut - pre.vaultOut, fill.amountOut, 'all route output reached the user (surplus returned)')
    assert.ok(fill.amountOut * c.amount >= c.minimum * fill.amountIn, 'user limit holds pro rata')
    noStrandedBalances(post)
    return ['finalized', 'input-debit', 'output-credit', 'unlocked', 'commitment-closed', 'vault-conservation', 'limit-pro-rata', 'no-stranded-balances']
  }
  const checkRejected = (c, pre, post) => {
    assert.deepEqual(post, pre, 'rejected settlement leaves vault, reservation and adapter state unchanged')
    assert.equal(post.finalized, false); assert.equal(post.locked, c.amount); assert.equal(post.open, 1n)
    noStrandedBalances(post)
    return ['not-finalized', 'state-identical', 'reservation-kept', 'no-stranded-balances']
  }
  // A settler may finalize at a band price that violates the order's limit: no fill, reservation released.
  const checkFinalizedUnfilled = (c, pre, post) => {
    assert.equal(post.finalized, true); assert.equal(post.locked, 0n); assert.equal(post.open, 0n)
    assert.equal(post.userIn, pre.userIn); assert.equal(post.userOut, pre.userOut)
    assert.equal(post.vaultIn, pre.vaultIn); assert.equal(post.vaultOut, pre.vaultOut)
    noStrandedBalances(post)
    return ['finalized', 'no-fill', 'reservation-released', 'balances-unchanged', 'no-stranded-balances']
  }
  const fillOf = (r) => {
    if (r?.status !== 'success') return null
    const f = parseEventLogs({ abi: S.abi, logs: r.logs, eventName: 'Filled' }).map((x) => x.args)
    const s = parseEventLogs({ abi: S.abi, logs: r.logs, eventName: 'Settled' }).map((x) => x.args)
    const e = parseEventLogs({ abi: S.abi, logs: r.logs, eventName: 'ExternalSettled' }).map((x) => x.args)
    assert.ok(f.length <= 1 && s.length === 1 && e.length === 1)
    return { amountIn: f[0]?.amountIn ?? 0n, amountOut: f[0]?.amountOut ?? 0n, settled: s[0], external: e[0] }
  }
  const decodeSettle = (tx) => {
    const d = decodeFunctionData({ abi: S.abi, data: tx.input })
    return { fn: d.functionName, priceX96: d.args[1], marginal: d.args.length > 2 ? { id: d.args[2], amountIn: d.args[3] } : null }
  }
  const trade = async (sell, amount) => {
    const [o] = sell ? [WETH] : [USDC]
    const before = await balance(o, actor)
    const r = await sendAs('attacker', actor, A.abi, 'trade', [sell, amount])
    return { received: await balance(o, actor) - before, gasUsed: r.gasUsed }
  }
  const replay = async (tx) => receipt(await wallets.solver.sendTransaction({ to: tx.to, data: tx.input, gas: 3_000_000n }))

  for (const c of CASES) {
    log(`case ${c.id}`)
    await rewind('deployed')
    // ---- user prepares at commit time from a reference quote, limit at the 1% band edge (E1 convention).
    await warp(start)
    // The user quotes at commit time from the same reference function; a round trip first refreshes the pool's
    // activity observation (maxObservationAge) exactly as before settlement.
    const quoteWarm = await trade(true, 10_000n * 10n ** 6n); await trade(false, quoteWarm.received)
    const commitRef = await rd(market, M.abi, 'referencePrice', [(await latest()).timestamp])
    const limitPrice = c.sell ? commitRef - commitRef / 100n : commitRef + commitRef / 100n
    c.minimum = quoteOut(c.sell, c.amount, limitPrice)
    if (c.limitBps) {
      // eth_call of the same exact-input swap at commit time: a size-aware quote, not executed.
      const { result: expected } = await pub.simulateContract({ address: actor, abi: A.abi, functionName: 'trade', args: [c.sell, c.amount], account: attacker.address })
      c.commitSimulatedOut = expected
      c.minimum = expected * BigInt(10_000 - c.limitBps) / 10_000n
    }
    const order = { owner: user.address, zeroForOne: c.sell, amountIn: c.amount, minAmountOut: c.minimum }
    const orderSalt = toHex(BigInt(keccak256(toHex(c.id))) >> 8n, { size: 32 })
    const batch = await rd(settlement, S.abi, 'currentBatch')
    assert.equal(batch, 0n)
    const hash = await rd(settlement, S.abi, 'orderHash', [batch, order, orderSalt])
    const cr = await sendAs('user', settlement, S.abi, 'commit', [batch, hash, '0x01'])
    const id = parseEventLogs({ abi: S.abi, logs: cr.logs, eventName: 'Committed' })[0].args.commitId
    await warp(await rd(settlement, S.abi, 'revealOpens', [batch]))
    await sendAs('user', settlement, S.abi, 'reveal', [id, order, orderSalt])
    const closes = await rd(settlement, S.abi, 'revealCloses', [batch])
    // Identical 10,000-USDC round trip refreshes the activity observation, as in E1.
    await warp(closes - 4n)
    const warm = await trade(true, 10_000n * 10n ** 6n); await trade(false, warm.received)
    await warp(closes)
    const reference = await rd(settlement, S.abi, 'referencePriceX96', [batch])
    const caseInfo = { ...c, orderId: id, order, commitReferenceX96: commitRef, limitPriceX96: limitPrice, referenceX96: reference, revealCloses: closes,
      readySpotX96: await spotX96(), readySpotVsReferenceBps: null }
    caseInfo.readySpotVsReferenceBps = priceOffsetBps(c.sell, caseInfo.readySpotX96, reference)
    await mark('ready')
    const ready = await vaultState(c)
    assert.equal(ready.locked, c.amount)

    // ---- clean control: an empty block stands in for the front-run so block/timestamp sequences match.
    await rpc('evm_mine')
    const clean = await runCli(deployment, settlement, 'clean')
    if (clean.outcome !== 'settled') {
      log(`clean CLI did not settle: ${clean.outcome} ${clean.stderr}`)
      caseInfo.clean = clean; results.cases.push(caseInfo); save()
      checkRejected(c, ready, await vaultState(c))
      continue
    }
    const cleanFill = fillOf(clean.receipt)
    const cleanCall = decodeSettle(clean.transaction)
    const cleanChecks = checkSettled(c, ready, await vaultState(c), cleanFill)
    caseInfo.clean = { ...clean, receipt: { status: clean.receipt.status, gasUsed: clean.receipt.gasUsed, blockNumber: clean.receipt.blockNumber },
      transaction: { hash: clean.transaction.hash, input: clean.transaction.input, from: clean.transaction.from }, call: cleanCall,
      priceOffsetBps: priceOffsetBps(c.sell, cleanCall.priceX96, reference), fill: { amountIn: cleanFill.amountIn, amountOut: cleanFill.amountOut },
      surplus: cleanFill.external, floorOut: quoteOut(c.sell, cleanFill.amountIn, cleanCall.priceX96), checks: cleanChecks }
    caseInfo.clean.floorSlackBps = bps(cleanFill.amountOut - caseInfo.clean.floorOut, cleanFill.amountOut)
    caseInfo.clean.partial = cleanFill.amountIn < c.amount
    log(`  clean: ${clean.simulations} sims, price ${caseInfo.clean.priceOffsetBps} bps from ref, out ${cleanFill.amountOut}, in ${cleanFill.amountIn}/${c.amount}, slack ${caseInfo.clean.floorSlackBps} bps`)

    // ---- controls: repeat CLI from the same state (determinism) and replay the clean calldata (replay mechanism).
    await rewind('ready'); await rpc('evm_mine')
    const repeat = await runCli(deployment, settlement, 'clean-repeat')
    const repeatFill = fillOf(repeat.receipt)
    results.controls.push({ caseId: c.id, control: 'clean-cli-repeat', outcome: repeat.outcome, identicalCalldata: repeat.transaction?.input === clean.transaction.input,
      identicalFill: repeatFill?.amountOut === cleanFill.amountOut && repeatFill?.amountIn === cleanFill.amountIn, simulations: repeat.simulations })
    assert.equal(repeat.transaction?.input, clean.transaction.input, 'CLI is deterministic from an identical state')
    await rewind('ready'); await rpc('evm_mine')
    const rr = await replay(clean.transaction)
    const rrFill = fillOf(rr)
    results.controls.push({ caseId: c.id, control: 'clean-replay', status: rr.status, identicalFill: rrFill?.amountOut === cleanFill.amountOut })
    assert.equal(rrFill?.amountOut, cleanFill.amountOut, 'replayed clean calldata reproduces the clean fill')
    if (c.id === CASES[0].id) {
      // Availability control: nobody settles; after the window expire() releases the reservation.
      await rewind('ready')
      await warp(await rd(settlement, S.abi, 'settleCloses', [batch]))
      const pre = await vaultState(c)
      await sendAs('attacker', settlement, S.abi, 'expire', [batch])
      const post = await vaultState(c)
      assert.equal(post.locked, 0n); assert.equal(post.open, 0n); assert.equal(post.userIn, pre.userIn); assert.equal(post.finalized, true)
      results.controls.push({ caseId: c.id, control: 'expire-after-window', ok: true, note: 'unsettled batch releases full input; no execution' })
    }
    results.cases.push(caseInfo); save()

    const row = (mode, front, extra) => ({ caseId: c.id, mode, frontUnits: front.units, frontIn: front.in, ...extra })
    const finish = async (mode, front, settle, pre, preAttack, extra = {}) => {
      // settle: { receipt, call, cli? }. Attacker closes the intermediate inventory exactly, then accounting.
      const fill = fillOf(settle.receipt)
      const post = await vaultState(c)
      let checks, victimLoss = null, victimLossBps = null
      if (fill && fill.amountIn === 0n) {
        checks = checkFinalizedUnfilled(c, pre, post)
      } else if (fill) {
        checks = checkSettled(c, pre, post, fill)
        // per-unit comparison so partial fills compare like for like
        victimLoss = cleanFill.amountOut * fill.amountIn / cleanFill.amountIn - fill.amountOut
        victimLossBps = bps(cleanFill.amountOut * fill.amountIn - fill.amountOut * cleanFill.amountIn, cleanFill.amountOut * fill.amountIn)
      } else checks = checkRejected(c, pre, post)
      const spotAtSettle = settle.spotBefore
      const back = await trade(!c.sell, front.received)
      const inT = c.sell ? USDC : WETH, outT = c.sell ? WETH : USDC
      assert.equal(await balance(outT, actor), preAttack.out, 'attacker closed intermediate inventory')
      const backOut = (await balance(inT, actor)) - (preAttack.in - front.in)
      const acct = attackAccounting({ frontIn: front.in, backOut, gasUnits: front.gasUsed + back.gasUsed, baseFeeWei: results.fork.baseFeePerGas,
        ethToInput: (w) => c.sell ? weiToToken0(w, reference) : w })
      const filled = fill && fill.amountIn > 0n
      const refOut = filled ? quoteOut(c.sell, fill.amountIn, reference) : null
      const r = row(mode, front, { outcome: filled ? 'settled' : fill ? 'finalized-unfilled' : settle.outcome ?? 'settlement-reverted', ...extra,
        outputVsReferenceBps: filled ? bps(refOut - fill.amountOut, refOut) : null,
        spotAfterFrontVsReferenceBps: priceOffsetBps(c.sell, spotAtSettle, reference),
        settlement: { status: settle.receipt?.status ?? null, gasUsed: settle.receipt?.gasUsed ?? null, error: settle.error ?? null,
          call: settle.call, priceOffsetBps: settle.call?.priceX96 ? priceOffsetBps(c.sell, settle.call.priceX96, reference) : null },
        fill: fill ? { amountIn: fill.amountIn, amountOut: fill.amountOut, partial: fill.amountIn < c.amount } : null,
        victimLoss, victimLossBps, attacker: acct, checks })
      results.rows.push(r); save()
      log(`  ${mode} front ${front.units}u: ${r.outcome}${filled ? ` loss ${victimLossBps} bps` : ''} attacker gross ${acct.grossProfitInput} net ${acct.netBeforeBuilderInput}`)
      return r
    }
    const frontRun = async (units) => {
      const preAttack = { in: await balance(c.sell ? USDC : WETH, actor), out: await balance(c.sell ? WETH : USDC, actor) }
      const f = await trade(c.sell, units * c.unit)
      return { front: { units, in: units * c.unit, received: f.received, gasUsed: f.gasUsed }, preAttack }
    }
    const cliSettle = async (label) => {
      const spotBefore = await spotX96()
      const r = await runCli(deployment, settlement, label)
      const summary = { outcome: r.outcome, simulations: r.simulations, wallMs: r.wallMs, inputSnapshot: r.inputSnapshot, simulationErrors: r.simulationErrors,
        lastSimulation: r.lastSimulation, stderr: r.stderr || undefined, revertSelector: r.revertSelector, rpcErrors: r.rpcErrors.length ? r.rpcErrors : undefined }
      return { receipt: r.receipt, call: r.transaction ? decodeSettle(r.transaction) : null, outcome: r.outcome, spotBefore, cli: summary }
    }

    for (const units of c.fronts ?? FRONT_UNITS) {
      // Mode A: the clean candidate is already broadcast; the front-run lands first; exact calldata executes.
      await rewind('ready')
      let { front, preAttack } = await frontRun(units)
      const spotBefore = await spotX96()
      const r = await replay(clean.transaction)
      const a = await finish('replay-selected', front, { receipt: r, call: cleanCall, spotBefore, error: r.status === 'success' ? null : 'reverted' }, ready, preAttack)
      if (!a.fill) {
        // Mode A2: after the stale candidate reverts, the attacker holds inventory and the CLI retries (next poll).
        await rewind('ready')
        ;({ front, preAttack } = await frontRun(units))
        await replay(clean.transaction)
        const s = await cliSettle('retry-after-revert')
        await finish('retry-after-revert', front, s, ready, preAttack, { cli: s.cli })
      }
      // Mode C: a permissionless settler (here the attacker) chooses the worst band-edge price itself, as in E1.
      // Same attacked state as mode B; full-order call only (partial cases use the CLI's marginal amount when it had one).
      await rewind('ready')
      ;({ front, preAttack } = await frontRun(units))
      await mark('attacked')
      const edge = c.sell ? reference - reference / 100n : reference + reference / 100n
      const edgeArgs = cleanCall.marginal ? [0n, edge, cleanCall.marginal.id, cleanCall.marginal.amountIn] : [0n, edge]
      const spotEdge = await spotX96()
      const er = await receipt(await wallets.attacker.writeContract({ address: settlement, abi: S.abi, functionName: 'settleExternal', args: edgeArgs, gas: 3_000_000n }))
      await finish('band-edge-settler', front, { receipt: er, call: { fn: 'settleExternal', priceX96: edge, marginal: cleanCall.marginal }, spotBefore: spotEdge,
        error: er.status === 'success' ? null : 'reverted' }, ready, preAttack)
      // Mode B: the movement precedes the CLI's search; the CLI searches and settles on the moved state.
      await rewind('attacked')
      const s = await cliSettle('search-after-front')
      await finish('search-after-front', front, s, ready, preAttack, { cli: s.cli })
    }
  }
  results.finishedAt = new Date().toISOString()
  save()
  log(`completed ${results.rows.length} scenario rows across ${results.cases.length} cases; results ${OUT}`)
} catch (e) {
  exitCode = 1
  results.error = { message: e.message, stack: e.stack, anvil: nodeErrors.slice(-4000) }
  save()
  console.error(e)
} finally {
  proxy.close()
  node.kill('SIGTERM')
  await new Promise((r) => (node.exitCode !== null ? r() : node.on('close', r)))
  rmSync(directory, { recursive: true, force: true })
  const cache = join(homedir(), '.foundry/cache/rpc/mainnet', String(forkBlock))
  if (existsSync(cache)) {
    const copy = OUT.replace(/\.json$/, `-fork-cache-${forkBlock}`)
    try { cpSync(cache, copy, { recursive: true }); results.forkCache = { path: copy, note: 'anvil fork cache copy; a rerun at this block can restore it under ~/.foundry/cache/rpc/mainnet' } } catch (e) { results.forkCacheError = e.message }
    writeFileSync(OUT, json(results))
  }
  process.exit(exitCode)
}
