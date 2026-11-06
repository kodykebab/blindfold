// Read-only historical measurements. Uses generated interfaces, never copied ABIs.
// source env.sh; CONTRACTS_DIR=/path/to/contracts node packages/solver/benchmark-market.mjs
import { readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createPublicClient, http } from 'viem'
import { artifactPath } from './artifacts.mjs'
const root = resolve(process.env.CONTRACTS_DIR || new URL('../../contracts', import.meta.url).pathname)
const abi = (name) => JSON.parse(readFileSync(artifactPath(join(root, 'out'), name, 'IExternalMarket'))).abi
const rpc = process.env.ETH_RPC || 'https://ethereum-rpc.publicnode.com'
const client = createPublicClient({ transport: http(rpc, { timeout: 15000, retryCount: 0 }) })
if (await client.getChainId() !== 1) throw new Error('Ethereum mainnet RPC required')
// Canonical factory and token identities; resolve the pool from factory state.
const factory = '0x1F98431c8aD98523631AE4a59f267346ea31F984'
const token0 = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const token1 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const latest = await client.getBlockNumber()
const address = await client.readContract({ address: factory, abi: abi('IV3Factory'), functionName: 'getPool', args: [token0, token1, 500], blockNumber: latest })
const step = Number(process.env.BLOCK_STEP || 600)
if (!Number.isSafeInteger(step) || step < 1) throw new Error('invalid BLOCK_STEP')
const blocks = process.env.BLOCKS?.split(',').map(BigInt) ?? Array.from({length:13}, (_,i)=>latest-BigInt(i)*BigInt(step))
const samples = []
for (const blockNumber of blocks) {
  const began = performance.now()
  try {
    const read = (functionName,args=[]) => client.readContract({address,abi:abi('IV3Pool'),functionName,args,blockNumber})
    const [block, slot, observed] = await Promise.all([client.getBlock({blockNumber}), read('slot0'), read('observe',[[600,0]])])
    const observation = await read('observations',[slot[2]])
    const delta = observed[0][1]-observed[0][0]
    const meanTick = delta / 600n - (delta < 0n && delta % 600n !== 0n ? 1n : 0n)
    const liquidityDelta = (observed[1][1]-observed[1][0]+(1n<<160n))%(1n<<160n)
    const harmonicLiquidity = (600n*((1n<<160n)-1n))/(liquidityDelta<<32n)
    const observationAge = (block.timestamp-BigInt(observation[0])+(1n<<32n))%(1n<<32n)
    const meanPrice = Math.pow(1.0001, Number(meanTick))
    const spotPrice = (Number(slot[0])/2**96)**2
    samples.push({blockNumber,timestamp:block.timestamp,observationAge,harmonicLiquidity,
      spotDeviationBpsApprox:Math.abs(spotPrice/meanPrice-1)*10000,readMs:Math.round(performance.now()-began)})
  } catch (error) {
    samples.push({blockNumber,error:error.shortMessage??error.message,readMs:Math.round(performance.now()-began)})
  }
}
console.log(JSON.stringify({chainId:1,factory,pool:address,token0,token1,windowSeconds:600,
  note:'Historical samples and read latency only; not proof of manipulation resistance or settlement simulation latency.',samples},
  (_,v)=>typeof v==='bigint'?v.toString():v,2))
if(samples.some((s)=>s.error)) process.exitCode=1
