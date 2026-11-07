// Deploys both demo scenes with the deployer wallet and writes their deployments files.
//   Scene 1, the unprotected swap: a 0.3% Uniswap v3 pool with two demo tokens, a router and a funded sniper.
//     -> deployments/demo.testnet.json
//   Scene 2, Blindfold: two demo tokens, the vault, a BlindfoldSettlement on a drand-aligned schedule and its sealed
//     pool (SealedPoolHook, CREATE2-mined on the v4 PoolManager, so only the settlement can swap there) with
//     liquidity for the residual; every victim gets VICTIM_TOKENS of each token.
//     -> deployments/blindfold.testnet.json (the client/keeper/solver format)
// Env: POOL_ETH (0.02) demo tokens of pool liquidity, BOT_ETH (0.02), POOL_MANAGER (address, or `new`), VICTIM_TOKENS (1000), BATCH_SECONDS (60),
//      DEPOSIT (1 token1 per commitment), SEALED_LIQUIDITY (10000 tokens). Contracts come from contracts/out: run `forge build` first.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseEther, toHex } from 'viem'
import {
  BLINDFOLD_FILE, E, ROLES, SANDWICH_FILE, VICTIMS, account, artifact, chain, demoArtifact, mined, pub, readJson, v3Artifact, victimIndex,
  wallet,
} from './common.mjs'
import { createdV3Pool, drandSchedule, mineHookSalt, v3FactoryFromManifest, waitForState } from './lib.mjs'

const deployer = account(ROLES.deployer)
const sniper = account(ROLES.sniper)
// Uniswap's own v4 PoolManager (docs.uniswap.org deployments); elsewhere, or with POOL_MANAGER=new, deploy.mjs deploys one
const V4_POOL_MANAGER = { 1301: '0x00B036B58a818B1BC34d502D3fE730Db729e62AC' } // Unichain Sepolia

async function deploy(acct, file, name, args = [], value) {
  const { abi, bytecode } = artifact(file, name)
  const rc = await mined(await wallet(acct).deployContract({ abi, bytecode: bytecode.object, args, value }))
  console.log(`  ${name} ${rc.contractAddress}`)
  await waitForState(async () => ((await pub.getCode({ address: rc.contractAddress }))?.length ?? 0) > 2)
  return rc.contractAddress
}
const call = async (address, file, name, functionName, args, value, acct = deployer) =>
  mined(await wallet(acct).writeContract({ address, abi: artifact(file, name).abi, functionName, args, value }))
const save = (path, obj) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(obj, null, 1))
  console.log(`wrote ${path}`)
}

async function sandwichScene() {
  console.log('scene 1: Uniswap v3 pool')
  const poolAmount = parseEther(E.POOL_ETH || '0.02')
  const known = E.POOL_MANAGER === 'new' ? undefined : E.POOL_MANAGER || V4_POOL_MANAGER[chain.id]
  if (known && !((await pub.getCode({ address: known }))?.length > 2)) throw new Error(`no code at POOL_MANAGER ${known}`)
  const pm = known ?? await deploy(deployer, 'PoolManager.sol', 'PoolManager', [deployer.address])
  let factory = E.V3_FACTORY
  if (!factory && chain.id === 1301) {
    const response = await fetch('https://raw.githubusercontent.com/Uniswap/contracts/main/deployments/1301.md')
    if (!response.ok) throw new Error('cannot fetch Uniswap deployment manifest; set V3_FACTORY')
    const document = await response.text()
    factory = v3FactoryFromManifest(document)
  }
  const FACTORY = v3Artifact('UniswapV3Factory')
  if (!factory) {
    factory = (await mined(await wallet(deployer).deployContract({ abi: FACTORY.abi, bytecode: FACTORY.bytecode }))).contractAddress
  }
  if (!((await pub.getCode({ address: factory }))?.length > 2)) throw new Error(`no code at V3_FACTORY ${factory}`)
  const a = await deploy(deployer, 'MockERC20.sol', 'MockERC20', ['Demo Input', 'DIN', 18])
  const b = await deploy(deployer, 'MockERC20.sol', 'MockERC20', ['Demo Output', 'DOUT', 18])
  const [token0, token1] = [a, b].sort((x, y) => BigInt(x) < BigInt(y) ? -1 : 1)
  const created = await mined(await wallet(deployer).writeContract({ address: factory, abi: FACTORY.abi, functionName: 'createPool', args: [token0, token1, 3000] }))
  const pool = createdV3Pool(created, factory, FACTORY.abi)
  console.log(`  v3 pool ${pool}`)
  const POOL = v3Artifact('UniswapV3Pool')
  await waitForState(async () => ((await pub.getCode({ address: pool }))?.length ?? 0) > 2)
  await mined(await wallet(deployer).writeContract({ address: pool, abi: POOL.abi, functionName: 'initialize', args: [2n ** 96n] }))
  await waitForState(async () => (await pub.readContract({ address: pool, abi: POOL.abi, functionName: 'slot0' }))[0] !== 0n)
  const ACTOR = demoArtifact('V3Demo')
  const deployActor = async (acct) => {
    const address = (await mined(await wallet(acct).deployContract({ abi: ACTOR.abi, bytecode: ACTOR.bytecode.object, args: [pool] }))).contractAddress
    await waitForState(async () => ((await pub.getCode({ address }))?.length ?? 0) > 2)
    return address
  }
  const router = await deployActor(deployer)
  const bot = await deployActor(sniper)
  const sealedBot = await deploy(sniper, 'DemoSwap.sol', 'SandwichBot', [pm])
  for (const token of [token0, token1]) await call(token, 'MockERC20.sol', 'MockERC20', 'mint', [router, poolAmount * 2n])
  await mined(await wallet(deployer).writeContract({ address: router, abi: ACTOR.abi, functionName: 'addLiquidity', args: [poolAmount] }))
  await call(token0, 'MockERC20.sol', 'MockERC20', 'mint', [bot, parseEther(E.BOT_ETH || '0.02')])
  for (let i = 0; i < VICTIMS; i++) await call(token0, 'MockERC20.sol', 'MockERC20', 'mint', [account(victimIndex(i)).address, poolAmount * 5n])
  save(SANDWICH_FILE, { chainId: chain.id, deployBlock: Number(await pub.getBlockNumber()), poolManager: pm, factory, pool, token0, token1, router, bot, sealedBot })
}

async function blindfoldScene() {
  console.log('scene 2: Blindfold sealed batch auction')
  const S = ['BlindfoldSettlement.sol', 'BlindfoldSettlement']
  const a = await deploy(deployer, 'MockERC20.sol', 'MockERC20', ['Demo Wrapped Ether', 'dWETH', 18])
  const b = await deploy(deployer, 'MockERC20.sol', 'MockERC20', ['Demo USD', 'dUSD', 18])
  const [token0, token1] = [a, b].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1))
  const vault = await deploy(deployer, 'BlindfoldVault.sol', 'BlindfoldVault')
  const deployBlock = await pub.getBlockNumber()
  const manager = readJson(SANDWICH_FILE, 'Deploy scene 1 first: both scenes share its PoolManager.').poolManager
  const schedule = drandSchedule((await pub.getBlock()).timestamp, E.BATCH_SECONDS || 60)
  const settlement = await deploy(deployer, ...S, [{
    manager, vault, depositToken: token1,
    depositAmount: parseEther(E.DEPOSIT || '1'), commitFee: 0n, bountyBps: 2000n, treasury: deployer.address, schedule,
    toleranceBps: 100n,
  }])
  await call(vault, 'BlindfoldVault.sol', 'BlindfoldVault', 'setOperator', [settlement])
  const factory = await deploy(deployer, 'AdmissionPoolFactory.sol', 'AdmissionPoolFactory')
  const F = ['AdmissionPoolFactory.sol', 'AdmissionPoolFactory']
  const bytecodeHash = await pub.readContract({ address: factory, abi: artifact(...F).abi, functionName: 'initCodeHash', args: [manager, settlement] })
  const { salt, address: hooks } = mineHookSalt(factory, bytecodeHash)
  await call(factory, ...F, 'deployHook', [manager, settlement, salt])
  console.log(`  SealedPoolHook ${hooks}`)
  await waitForState(async () => ((await pub.getCode({ address: hooks }))?.length ?? 0) > 2)
  const key = { currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks }
  await call(manager, 'PoolManager.sol', 'PoolManager', 'initialize', [key, 2n ** 96n])
  await call(settlement, ...S, 'initialize', [key])
  const liq = parseEther(E.SEALED_LIQUIDITY || '10000')
  const lp = await deploy(deployer, 'PoolModifyLiquidityTest.sol', 'PoolModifyLiquidityTest', [manager])
  for (const t of [token0, token1]) {
    await call(t, 'MockERC20.sol', 'MockERC20', 'mint', [deployer.address, liq * 2n])
    await call(t, 'MockERC20.sol', 'MockERC20', 'approve', [lp, liq * 2n])
  }
  await call(lp, 'PoolModifyLiquidityTest.sol', 'PoolModifyLiquidityTest', 'modifyLiquidity', [key, { tickLower: -887220, tickUpper: 887220, liquidityDelta: liq, salt: toHex(0n, { size: 32 }) }, '0x'])
  const amount = parseEther(E.VICTIM_TOKENS || '1000')
  for (let i = 0; i < VICTIMS; i++) {
    for (const t of [token0, token1]) await call(t, 'MockERC20.sol', 'MockERC20', 'mint', [account(victimIndex(i)).address, amount])
  }
  save(BLINDFOLD_FILE, {
    chainId: chain.id, deployBlock: Number(deployBlock), mode: 'testnet', vault, settlement, token0, token1,
    depositToken: token1, admission: 'off', poolKey: key, poolManager: manager, schedule: Object.fromEntries(Object.entries(schedule).map(([k, v]) => [k, Number(v)])),
  })
}

const only = process.argv[2]
if (!only || only === 'sandwich') await sandwichScene()
if (!only || only === 'blindfold') await blindfoldScene()

process.exit(0) // close RPC keep-alive sockets after the command completes
