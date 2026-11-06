// Isolated local stack: real web service, client, keeper, solver and contracts.
// Recorded drand and local test tokens keep the fixture deterministic. STACK_REAL_PROOF=1 uses generated verifiers and fresh proofs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, defineChain, getCreate2Address, http, toHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { artifactPath } from '../artifacts.mjs'

const enabled = process.env.STACK_E2E === '1'
const real = process.env.STACK_REAL_PROOF === '1'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const out = process.env.CONTRACTS_OUT || join(root, 'contracts/out')
const art = (name) => JSON.parse(readFileSync(artifactPath(out, name), 'utf8'))
const mnemonic = 'test test test test test test test test test test test junk'
const user = (i) => mnemonicToAccount(mnemonic, { addressIndex: i })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function freePort() {
  const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening')
  const p = s.address().port; await new Promise((r) => s.close(r)); return p
}
const command = (file, args, env) => new Promise((resolve, reject) => execFile(process.execPath, [file, ...args], { env, timeout: real ? 300000 : 45000 }, (error, stdout, stderr) => error ? reject(Error(`${file}: ${stderr || stdout || error.message}`)) : resolve(stdout)))

test('web order reaches the real keeper and solver and both traders withdraw', { skip: !enabled, timeout: real ? 1_200_000 : 180_000 }, async (t) => {
  const port = await freePort(), webPort = await freePort()
  const rpc = `http://127.0.0.1:${port}`, origin = `http://127.0.0.1:${webPort}`
  // The chain is initialized in the past for the recorded beacon; later blocks use normal Anvil time.
  const batchLength = real ? 300 : 60
  const batch = real ? 1n : 0n
  const start = 1692803367 + 3 * 999997 - (real ? 600 : 60)
  const anvil = spawn('anvil', ['--silent', '--port', String(port), '--accounts', '20', '--gas-limit', '300000000', '--timestamp', String(start)], { stdio: 'ignore' })
  const dir = mkdtempSync(join(tmpdir(), 'blindfold-stack-e2e-'))
  let web
  try {
    const chain = defineChain({ id: 31337, name: 'local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
    const pub = createPublicClient({ chain, transport: http(rpc), pollingInterval: 50 })
    const wallet = createWalletClient({ account: user(0), chain, transport: http(rpc) })
    for (let i = 0; ; i++) { try { await pub.getChainId(); break } catch { if (i > 100) throw Error('Anvil did not start'); await sleep(50) } }
    const wait = async (hash) => { const receipt = await pub.waitForTransactionReceipt({ hash }); assert.equal(receipt.status, 'success'); return receipt }
    const deploy = async (name, args = []) => (await wait(await wallet.deployContract({ abi: art(name).abi, bytecode: art(name).bytecode.object, args }))).contractAddress
    const write = async (address, name, functionName, args = []) => wait(await wallet.writeContract({ address, abi: art(name).abi, functionName, args }))
    const read = (address, name, functionName, args = []) => pub.readContract({ address, abi: art(name).abi, functionName, args })
    const manager = await deploy('PoolManager', [user(0).address])
    const a = await deploy('MockERC20', ['Token A', 'TKA', 18]), b = await deploy('MockERC20', ['Token B', 'TKB', 18])
    const [token0, token1] = [a, b].sort((x, y) => BigInt(x) < BigInt(y) ? -1 : 1)
    const vault = await deploy(real ? 'AdmissionVault' : 'BlindfoldVault', real ? [token0, token1] : [])
    const verifiers = []
    if (real) {
      assert.ok(process.env.ADMISSION_PARAMS && process.env.ADMISSION_PROVER && process.env.ADMISSION_MANIFEST_SHA256, 'real-proof mode requires prepared parameters, manifest hash and prover')
      for (const mode of ['preparation', 'online']) {
        const verifier = JSON.parse(readFileSync(join(process.env.ADMISSION_PARAMS, 'out', `${mode}.sol`, 'Verifier.json'), 'utf8'))
        verifiers.push((await wait(await wallet.deployContract({ abi: verifier.abi, bytecode: verifier.bytecode.object }))).contractAddress)
      }
    }
    const contract = real ? 'AdmittedSettlement' : 'BlindfoldSettlement'
    const settlement = await deploy(contract, [{ manager, vault, depositToken: token1, depositAmount: 5n * 10n ** 18n, commitFee: 1n,
      bountyBps: 2000n, treasury: user(9).address, schedule: { start, batchLength, revealLength: 24, settleLength: 30 }, toleranceBps: 100n }, ...verifiers])
    await write(vault, 'BlindfoldVault', 'setOperator', [settlement])
    const factory = await deploy('AdmissionPoolFactory')
    const bytecodeHash = await read(factory, 'AdmissionPoolFactory', 'initCodeHash', [manager, settlement])
    let hooks, salt
    for (let i = 0n; i < 500000n; i++) {
      const candidate = toHex(i, { size: 32 }), address = getCreate2Address({ from: factory, salt: candidate, bytecodeHash })
      if ((BigInt(address) & 16383n) === 128n) { hooks = address; salt = candidate; break }
    }
    assert.ok(salt, 'hook salt found')
    await write(factory, 'AdmissionPoolFactory', 'deployHook', [manager, settlement, salt])
    const key = { currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks }
    await write(manager, 'PoolManager', 'initialize', [key, 1n << 96n])
    await write(settlement, 'BlindfoldSettlement', 'initialize', [key])
    // Real v4 pool and hook; the ERC-20s are local test assets and the beacon round is recorded.
    const lp = await deploy('PoolModifyLiquidityTest', [manager])
    for (const token of [token0, token1]) {
      await write(token, 'MockERC20', 'mint', [user(0).address, 10n ** 30n])
      await write(token, 'MockERC20', 'approve', [lp, (1n << 256n) - 1n])
    }
    await write(lp, 'PoolModifyLiquidityTest', 'modifyLiquidity', [key, { tickLower: -60000, tickUpper: 60000, liquidityDelta: 10n ** 22n, salt: toHex(0n, { size: 32 }) }, '0x'])
    assert.ok((await read(settlement, 'BlindfoldSettlement', 'poolLiquidity')) > 0n)
    assert.equal(await read(settlement, 'BlindfoldSettlement', 'targetRound', [batch]), 1000000n)
    for (const index of [10, 11]) for (const token of [token0, token1]) await write(token, 'MockERC20', 'mint', [user(index).address, 100n * 10n ** 18n])
    const deployment = join(dir, 'deployment.json')
    writeFileSync(deployment, JSON.stringify({ chainId: 31337, deployBlock: 0, vault, settlement, token0, token1, depositToken: token1, admission: real ? { manifestSha256: process.env.ADMISSION_MANIFEST_SHA256, preparationVerifier: verifiers[0], onlineVerifier: verifiers[1] } : 'off' }))
    const env = { ...process.env, RPC_URL: rpc, DEPLOYMENTS: deployment, CONTRACTS_OUT: out, DRAND: join(root, 'packages/client/test/fixtures/drand.json'), MNEMONIC: mnemonic,
      PRIVATE_KEY: '', KEEPER_KEY: '', SOLVER_KEY: '', KEEPER_STATUS: join(dir, 'keeper-status.json'), KEEPER_BUDGET_WEI: '1000000000000000000', KEEPER_MIN_BALANCE_WEI: '0', CLIENT_ACCOUNT_INDEX: '10', CLIENT_STATE: join(dir, 'user10'), PORT: String(webPort), OFFLINE: '1', ...(real ? { ADMISSION_MIN_LEAD_SECONDS: '120' } : {}) }
    web = spawn(process.execPath, ['server.mjs'], { cwd: join(root, 'app/haveibeensandwiched'), env, stdio: ['ignore', 'pipe', 'pipe'] })
    await Promise.race([once(web.stdout, 'data'), once(web, 'exit').then(([code]) => { throw Error(`web server exited ${code}`) })])
    const submit = async (body) => {
      const response = await fetch(`${origin}/api/trade`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-blindfold-request': '1' }, body: JSON.stringify(body) })
      assert.equal(response.status, 202, await response.clone().text())
      const { id } = await response.json()
      let job
      do { await sleep(200); job = await (await fetch(`${origin}/api/trade/${id}`)).json() } while (job.state === 'running')
      assert.equal(job.state, 'done', job.output)
      return job.output
    }
    const until = async (target) => { while ((await pub.getBlock({ blockTag: 'latest', cacheTime: 0 })).timestamp < target) { await sleep(1100); await pub.request({ method: 'evm_mine', params: [] }) } }
    for (const token of ['token0', 'token1']) {
      assert.match(await submit({ action: 'deposit', token, amount: '20' }), /deposited/)
      assert.match(await command(join(root, 'packages/client/cli.mjs'), ['deposit', token, '20'], { ...env, CLIENT_ACCOUNT_INDEX: '11', CLIENT_STATE: join(dir, 'user11') }), /deposited/)
    }
    if (real) {
      assert.match(await submit({ action: 'prepare-admission', batch: '1' }), /prepared batch 1/)
      assert.match(await command(join(root, 'packages/client/cli.mjs'), ['prepare-admission', '1'], { ...env, CLIENT_ACCOUNT_INDEX: '11', CLIENT_STATE: join(dir, 'user11') }), /prepared batch 1/)
      await until(await read(settlement, 'BlindfoldSettlement', 'commitsClose', [0n]))
    }
    const submitted = await submit({ action: 'commit', side: 'sell', amount: '10', minimum: '9' })
    assert.match(submitted, real ? /admitted #0/ : /committed #0/)
    const other = await command(join(root, 'packages/client/cli.mjs'), ['commit', 'buy', '10', '9'], { ...env, CLIENT_ACCOUNT_INDEX: '11', CLIENT_STATE: join(dir, 'user11') })
    assert.match(other, real ? /admitted #1/ : /committed #1/)
    t.diagnostic('Two real encrypted commitments submitted; waiting for the recorded drand round')
    await until(await read(settlement, 'BlindfoldSettlement', 'revealOpens', [batch]))
    const keeper = JSON.parse((await command(join(root, 'packages/keeper/keeper.mjs'), ['--once'], { ...env, KEEPER_INDEX: '1' })).trim().split('\n').at(-1))
    assert.equal(keeper.revealed, 2, JSON.stringify(keeper)); assert.deepEqual(keeper.errors, [])
    t.diagnostic('Real keeper decrypted and revealed both commitments')
    // A restarted (or second) keeper finds nothing left to reveal and keeps the recorded spend.
    const again = JSON.parse((await command(join(root, 'packages/keeper/keeper.mjs'), ['--once'], { ...env, KEEPER_INDEX: '1' })).trim().split('\n').at(-1))
    assert.equal(again.revealed, 0, JSON.stringify(again)); assert.deepEqual(again.errors, [])
    assert.ok(BigInt(again.spentWei) >= BigInt(keeper.spentWei), 'spend survives the restart')
    await until(await read(settlement, 'BlindfoldSettlement', 'revealCloses', [batch]))
    const result = await command(join(root, 'packages/solver/solver.mjs'), ['--once', '--json'], { ...env, SETTLEMENT_ARTIFACT: artifactPath(out, contract) })
    const solverStatus = JSON.parse(result.trim())
    assert.equal(solverStatus.due, 1); assert.equal(solverStatus.settled.length, 1)
    assert.equal(solverStatus.settled[0].batch, String(batch)); assert.deepEqual(solverStatus.errors, [])
    assert.equal(await read(settlement, 'BlindfoldSettlement', 'finalized', [batch]), true)
    // A restarted solver does not settle the finalized batch twice.
    const rerun = JSON.parse((await command(join(root, 'packages/solver/solver.mjs'), ['--once', '--json'], { ...env, SETTLEMENT_ARTIFACT: artifactPath(out, contract) })).trim())
    assert.equal(rerun.due, 0); assert.deepEqual(rerun.settled, []); assert.deepEqual(rerun.errors, [])
    for (const index of [10, 11]) {
      assert.equal(await read(vault, 'BlindfoldVault', 'openCommitments', [user(index).address]), 0n)
      const token = index === 10 ? token1 : token0
      const before = await read(token, 'MockERC20', 'balanceOf', [user(index).address])
      const cli = await command(join(root, 'packages/client/cli.mjs'), ['withdraw', index === 10 ? 'token1' : 'token0', 'all'], { ...env, CLIENT_ACCOUNT_INDEX: String(index), CLIENT_STATE: join(dir, `user${index}`) })
      assert.match(cli, /withdrew/)
      assert.ok((await read(token, 'MockERC20', 'balanceOf', [user(index).address])) > before)
    }
    t.diagnostic('Real solver settled the v4-backed batch; both traders withdrew')
  } finally { if (web && web.exitCode === null) { web.kill(); await once(web, 'exit') } anvil.kill() }
})
