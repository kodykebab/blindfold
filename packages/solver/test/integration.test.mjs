import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { BaseError, ContractFunctionRevertedError, TransactionReceiptNotFoundError, createPublicClient, createWalletClient, defineChain, http,
  getCreate2Address, toHex, parseEventLogs } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { solve, Q96, allocationsAt } from '../price.mjs'
import { solveExternal } from '../external.mjs'
import { solvePeer } from '../peer.mjs'
import { artifactPath } from '../artifacts.mjs'

const enabled = process.env.SOLVER_E2E === '1'
const contracts = resolve(process.env.CONTRACTS_DIR || new URL('../../../contracts', import.meta.url).pathname)
const contractOut = process.env.CONTRACTS_OUT || join(contracts, 'out')
const artifact = (name) => JSON.parse(readFileSync(artifactPath(contractOut, name, ['RouteFactoryMock', 'RoutePoolMock'].includes(name) ? 'UniswapV3Route.t' : name)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// No external RPC, real keys, or live funds: this test owns its fresh anvil process.
test('solver CLI executes sealed, peer, public and multi-hop batches with recovery', { skip: !enabled, timeout: 180_000 }, async (t) => {
  const listener = createServer()
  await new Promise((r) => listener.listen(0, '127.0.0.1', r))
  const port = listener.address().port
  await new Promise((r) => listener.close(r))
  const rpc = `http://127.0.0.1:${port}`
  const child = spawn('anvil', ['--silent', '--port', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] })
  let anvilOutput = ''
  child.stderr.on('data', (b) => { anvilOutput += b })
  const directory = mkdtempSync(join(tmpdir(), 'blindfold-solver-e2e-'))
  const chain = defineChain({ id: 31337, name: 'test', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } })
  const account = mnemonicToAccount('test test test test test test test test test test test junk')
  const client = createPublicClient({ chain, pollingInterval: 20, transport: http(rpc, { retryCount: 0, timeout: 15_000 }) })
  const wallet = createWalletClient({ account, chain, transport: http(rpc) })
  const load = (name) => artifact(name)
  // This fixture owns an automining node and never replaces a transaction.
  // Poll receipts directly so snapshot rewinds do not enter viem's replacement
  // watcher for block numbers reused by a later scenario.
  const minedReceipt = async (hash) => {
    const deadline = performance.now() + 15_000
    while (performance.now() < deadline) {
      try { return await client.getTransactionReceipt({hash}) }
      catch (e) { if (!(e instanceof TransactionReceiptNotFoundError)) throw e }
      await sleep(20)
    }
    throw new Error(`local transaction did not mine: ${hash}`)
  }
  const send = async (address, name, functionName, args = []) => {
    const hash = await wallet.writeContract({ address, abi: load(name).abi, functionName, args })
    const receipt = await minedReceipt(hash)
    assert.equal(receipt.status, 'success', functionName)
    return receipt
  }
  const deploy = async (name, args = []) => {
    const a = load(name)
    const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, gas: 25_000_000n })
    const receipt = await minedReceipt(hash)
    assert.equal(receipt.status, 'success', name)
    return receipt.contractAddress
  }
  const read = (address, name, functionName, args = []) => client.readContract({ address, abi: load(name).abi, functionName, args })
  const warp = async (timestamp) => {
    await client.request({ method: 'evm_setNextBlockTimestamp', params: [Number(timestamp)] })
    await client.request({ method: 'evm_mine', params: [] })
  }
  try {
    assert.ok(load('BlindfoldSettlement').abi.some((f) => f.name === 'settle' && f.inputs?.length === 4), 'build the proportional settlement contract first')
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`anvil exited: ${anvilOutput}`)
      try { await client.getChainId(); ready = true; break } catch { await sleep(30) }
    }
    assert.ok(ready, 'anvil started')
    const manager = await deploy('PoolManager', [account.address])
    const tokenA = await deploy('MockERC20', ['A', 'A', 18])
    const tokenB = await deploy('MockERC20', ['B', 'B', 18])
    const [token0, token1] = [tokenA, tokenB].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1)
    const vault = await deploy('BlindfoldVault')
    const now = (await client.getBlock()).timestamp
    const start = now - (now - 1692803367n) % 3n
    const commitFee = 10n ** 17n
    const treasury = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 1 }).address
    const settlement = await deploy('BlindfoldSettlement', [{ manager, vault, depositToken: token1,
      depositAmount: 5n * 10n ** 18n, bountyBps: 2000n, treasury, commitFee,
      schedule: { start: Number(start), batchLength: 300, revealLength: 24, settleLength: 30 }, toleranceBps: 100n }])
    await send(vault, 'BlindfoldVault', 'setOperator', [settlement])
    const factory = await deploy('SolverHookFactory')
    const bytecodeHash = await read(factory, 'SolverHookFactory', 'initCodeHash', [manager, settlement])
    let hook, salt
    for (let i = 0n; i < 500_000n; i++) {
      salt = toHex(i, { size: 32 })
      hook = getCreate2Address({ from: factory, salt, bytecodeHash })
      if ((BigInt(hook) & 0x3fffn) === 0x80n) break
      hook = undefined
    }
    assert.ok(hook, 'hook salt found')
    await send(factory, 'SolverHookFactory', 'deploy', [salt, manager, settlement])
    assert.ok((await client.getCode({ address: hook }))?.length > 2, 'hook deployed at the mined address')
    const key = { currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks: hook }
    await send(manager, 'PoolManager', 'initialize', [key, Q96])
    await send(settlement, 'BlindfoldSettlement', 'initialize', [key])
    const lp = await deploy('PoolModifyLiquidityTest', [manager])
    for (const token of [token0, token1]) {
      await send(token, 'MockERC20', 'mint', [account.address, 10n ** 30n])
      await send(token, 'MockERC20', 'approve', [lp, (1n << 256n) - 1n])
      await send(token, 'MockERC20', 'approve', [vault, (1n << 256n) - 1n])
      await send(vault, 'BlindfoldVault', 'deposit', [token, 10_000n * 10n ** 18n])
    }
    await send(lp, 'PoolModifyLiquidityTest', 'modifyLiquidity', [key, { tickLower: -60000, tickUpper: 60000, liquidityDelta: 10n ** 22n, salt: toHex(0n, { size: 32 }) }, '0x'])
    const deploymentPath = join(directory, 'deployment.json')
    writeFileSync(deploymentPath, JSON.stringify({ chainId: 31337, settlement }))
    let snapshot = await client.request({ method: 'evm_snapshot' })
    for (const scenario of [{ sell: true }, { sell: false }, { sell: true, noLiquidity: true }, { sell: true, noLiquidity: true, peerMode: true }, { sell: false, noLiquidity: true, peerMode: true }, { sell: true, noLiquidity: true, externalMode: true }, { sell: false, noLiquidity: true, externalMode: true }, { sell: true, noLiquidity: true, externalMode: true, partialExternal: true }, { sell: false, noLiquidity: true, externalMode: true, partialExternal: true }, { sell: true, noLiquidity: true, externalMode: true, multiHop: true }, { sell: false, noLiquidity: true, externalMode: true, multiHop: true }]) {
      const { sell, noLiquidity = false, peerMode = false, externalMode = false, partialExternal = false, multiHop = false } = scenario
      if (multiHop) {
        const middle = await deploy('MockERC20', ['Middle', 'M', 18])
        const factory = await deploy('RouteFactoryMock')
        const path = [token0, middle, token1]
        const hops = []
        for (let i = 0; i < 2; i++) {
          const [a, b] = [path[i], path[i+1]].sort((x,y)=>BigInt(x)<BigInt(y)?-1:1)
          const pool = await deploy('RoutePoolMock', [a, b, factory])
          await send(factory, 'RouteFactoryMock', 'setPool', [a,b,pool])
          for (const token of [a,b]) await send(token, 'MockERC20', 'mint', [pool, 10n ** 30n])
          hops.push({pool, minimumLiquidity: 10n ** 17n, maximumObservationAge: 600})
        }
        const route = await deploy('UniswapV3Route', [settlement, factory, path, hops, 600, 30, 100n])
        await send(settlement, 'BlindfoldSettlement', 'configureExternal', [route])
      } else if (peerMode || externalMode) {
        const market = await deploy('MockExternalMarket', [settlement, token0, token1])
        await send(settlement, 'BlindfoldSettlement', 'configureExternal', [market])
        if (externalMode) {
          for (const token of [token0, token1]) await send(token, 'MockERC20', 'mint', [market, 10_000n * 10n ** 18n])
          await send(market, 'MockExternalMarket', 'setOutputBps', [9990n])
          if (partialExternal) await send(market, 'MockExternalMarket', 'setMaxInput', [810n * 10n ** 18n])
        }
      }
      const batch = await read(settlement, 'BlindfoldSettlement', 'currentBatch')
      const orders = [1000n, 500n].map((amount, i) => ({ id: BigInt(i), owner: account.address, zeroForOne: peerMode && i === 1 ? !sell : sell,
        amountIn: amount * 10n ** 18n, minAmountOut: amount * 9n * 10n ** 17n }))
      for (const o of orders) {
        const salt = toHex(o.id + 1n, { size: 32 })
        const hash = await read(settlement, 'BlindfoldSettlement', 'orderHash', [batch, o, salt])
        await send(settlement, 'BlindfoldSettlement', 'commit', [batch, hash, '0x01'])
      }
      assert.equal(await read(vault, 'BlindfoldVault', 'balanceOf', [treasury, token1]), BigInt(orders.length) * commitFee)
      await warp(await read(settlement, 'BlindfoldSettlement', 'revealOpens', [batch]))
      for (const o of orders) await send(settlement, 'BlindfoldSettlement', 'reveal', [o.id, o, toHex(o.id + 1n, { size: 32 })])
      await warp(await read(settlement, 'BlindfoldSettlement', 'revealCloses', [batch]))
      if (noLiquidity) await send(lp, 'PoolModifyLiquidityTest', 'modifyLiquidity', [key, { tickLower: -60000, tickUpper: 60000, liquidityDelta: -(10n ** 22n), salt: toHex(0n, { size: 32 }) }, '0x'])
      let simulations = 0
      const simulate = async (p, m, peer = false, external = false) => {
        simulations++
        try {
          await client.simulateContract({ address: settlement, abi: load('BlindfoldSettlement').abi, functionName: peer ? 'settlePeer' : external ? 'settleExternal' : 'settle',
            args: peer ? [batch, m.id, m.amountIn] : m ? [batch, p, m.id, m.amountIn] : [batch, p], account })
          return { ok: true }
        } catch (e) {
          const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null
          if (external && revert) return { ok: false, error: revert.data?.errorName ?? 'ExternalRevert' }
          const err = e.walk?.((v) => v.data?.errorName)
          if (!err?.data?.errorName) throw e
          return err.data.errorName === 'NotMarginalPrice' ? { ok: false, poolX96: err.data.args[1] } : { ok: false, error: err.data.errorName }
        }
      }
      const searchStarted = performance.now()
      let solution = await solve({ simulate, poolX96: await read(settlement, 'BlindfoldSettlement', 'poolPriceX96'), toleranceBps: 100, orders })
      t.diagnostic(`${noLiquidity ? 'no liquidity' : sell ? 'sell' : 'buy'} search: ${simulations} simulations, ${Math.round(performance.now() - searchStarted)} ms on local anvil`)
      if (peerMode) {
        assert.equal(solution, null, 'AMM paths cannot clear this unequal crossing without liquidity')
        const beforePeerCalls = simulations
        const peerStarted = performance.now()
        solution = await solvePeer({ orders, priceX96: Q96, simulate: (m) => simulate(Q96, m, true) })
        t.diagnostic(`peer ${sell ? 'sell' : 'buy'} crossing: ${simulations - beforePeerCalls} simulation, ${Math.round(performance.now() - peerStarted)} ms locally`)
        assert.equal(simulations - beforePeerCalls, 1)
        assert.ok(solution?.peer)
        assert.equal(solution.peer.amountIn, 500n * 10n ** 18n)
      } else if (noLiquidity) assert.equal(solution, null)
      else {
        assert.ok(solution?.marginal, 'solver rescues the all-or-none gap')
        assert.ok((await simulate(solution.priceX96, solution.marginal)).ok)
        const expected = allocationsAt(orders, solution.priceX96, solution.marginal)
        assert.equal(expected[0], expected[1] * 2n)
      }
      if (externalMode) {
        const callsBefore = simulations
        const started = performance.now()
        const external = await solveExternal({ referenceX96: Q96, deviationBps: 100, orders,
          simulate: (p, m) => simulate(p, m, false, true) })
        assert.ok(external?.external)
        if (partialExternal) assert.equal(external.marginal.amountIn, 540n * 10n ** 18n)
        t.diagnostic(`external ${sell ? 'sell' : 'buy'}: ${simulations - callsBefore} simulations, ${Math.round(performance.now() - started)} ms locally`)
      }
      const startBlock = await client.getBlockNumber({ cacheTime: 0 })
      const cli = spawn(process.execPath, [new URL('../solver.mjs', import.meta.url).pathname, '--once'], {
        env: { ...process.env, RPC_URL: rpc, DEPLOYMENTS: deploymentPath,
          SETTLEMENT_ARTIFACT: artifactPath(contractOut, 'BlindfoldSettlement') }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      cli.stdout.on('data', (b) => { output += b })
      cli.stderr.on('data', (b) => { output += b })
      const [exitCode] = await once(cli, 'exit')
      assert.equal(exitCode, noLiquidity && !peerMode && !externalMode ? 1 : 0, output)
      if (noLiquidity && !peerMode && !externalMode) {
        assert.match(output, /search found no executable candidate/)
        assert.equal(await read(settlement, 'BlindfoldSettlement', 'finalized', [batch]), false)
        await warp(await read(settlement, 'BlindfoldSettlement', 'settleCloses', [batch]))
        await send(settlement, 'BlindfoldSettlement', 'expire', [batch])
        assert.equal(await read(vault, 'BlindfoldVault', 'balanceOf', [account.address, token0]), 10_000n * 10n ** 18n)
      }
      assert.equal(await read(settlement, 'BlindfoldSettlement', 'finalized', [batch]), true)
      assert.equal(await read(vault, 'BlindfoldVault', 'openCommitments', [account.address]), 0n)
      assert.equal(await read(vault, 'BlindfoldVault', 'balanceOf', [treasury, token1]), BigInt(orders.length) * commitFee, 'commit fees remain charged after settlement or expiry')
      assert.equal(await read(vault, 'BlindfoldVault', 'lockedOf', [account.address, sell ? token0 : token1]), 0n)
      const logs = await client.getLogs({ address: settlement, fromBlock: startBlock, toBlock: 'latest' })
      const fills = parseEventLogs({ abi: load('BlindfoldSettlement').abi, logs, eventName: 'Filled' })
      assert.equal(fills.length, noLiquidity && !peerMode && !externalMode ? 0 : 2)
      if (externalMode) assert.match(output, /public-pool residual route/)
      if (partialExternal) {
        assert.equal(fills[0].args.amountIn, 540n * 10n ** 18n)
        assert.equal(fills[1].args.amountIn, 270n * 10n ** 18n)
      }
      if (peerMode) assert.equal(fills[0].args.amountIn, fills[1].args.amountIn)
      else if (!noLiquidity) assert.equal(fills[0].args.amountIn, fills[1].args.amountIn * 2n)
      for (let i = 0; i < fills.length; i++) {
        assert.ok(fills[i].args.amountIn <= orders[i].amountIn)
        assert.ok(fills[i].args.amountOut * orders[i].amountIn >= orders[i].minAmountOut * fills[i].args.amountIn)
      }
      if (peerMode) {
        assert.match(output, /peer-only match/)
        const poolLogs = await client.getLogs({ address: manager, fromBlock: startBlock, toBlock: 'latest' })
        assert.equal(parseEventLogs({ abi: load('PoolManager').abi, logs: poolLogs, eventName: 'Swap' }).length, 0)
        assert.equal(await read(settlement, 'BlindfoldSettlement', 'poolPriceX96'), Q96)
        assert.equal(await read(vault, 'BlindfoldVault', 'balanceOf', [settlement, token0]), 0n)
        assert.equal(await read(vault, 'BlindfoldVault', 'balanceOf', [settlement, token1]), 0n)
      }
      await client.request({ method: 'evm_revert', params: [snapshot] })
      snapshot = await client.request({ method: 'evm_snapshot' })
    }
  } finally {
    child.kill('SIGTERM')
    if (child.exitCode === null) await once(child, 'exit')
    rmSync(directory, { recursive: true, force: true })
  }
})
