import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, ContractFunctionRevertedError, encodeAbiParameters } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { solve } from './solver.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export async function artifact(name, source = name) {
  const directory=resolve(root,`contracts/out/${source}.sol`);
  const files=await readdir(directory);
  const file=files.includes(`${name}.json`)?`${name}.json`:files.includes(`${name}.0.8.26.json`)?`${name}.0.8.26.json`:null;
  if(!file) throw new Error(`missing canonical artifact for ${name}; run forge build`);
  return JSON.parse(await readFile(resolve(directory,file),'utf8'));
}
export async function run(env = process.env) {
  const address = env.GLOBAL_AUCTION;
  if (!address) throw new Error('GLOBAL_AUCTION is required');
  const client = createPublicClient({ transport: http(env.RPC_URL || 'http://127.0.0.1:8545') });
  const abi = (await artifact('GlobalAuction')).abi;
  const read = (functionName, args = []) => client.readContract({ address, abi, functionName, args });
  let batch;
  if (env.BATCH !== undefined) batch=BigInt(env.BATCH);
  else {
    const now=(await client.getBlock()).timestamp, first=await read('revealCloses',[0n]);
    if(now<first) return {reason:'no batch is ready for settlement'};
    batch=(now-first)/BigInt(await read('batchLength'));
    if(await read('finalized',[batch]) || now>=await read('settleCloses',[batch])) return {batch,reason:'no live settlement window'};
  }
  const ids = await read('commitIdsOf', [batch]);
  const count = Number(await read('tokenCount'));
  const prices=await Promise.all(Array.from({length:count},async(_,i)=>{
    try{return await read('tokenPriceX96',[batch,i]);}
    catch(error){if(error.walk?.(e=>e instanceof ContractFunctionRevertedError))return 0n;throw error;}
  }));
  const tokens = await Promise.all(Array.from({ length: count }, (_, i) => read('tokens', [BigInt(i)])));
  const orders = await Promise.all(ids.map(async id => {
    const c = await read('commitments', [id]); if (Number(c[3]) !== 2) return null;
    const o = await read('orders', [id]);
    return { owner: o[0], tokenIn: Number(o[1]), tokenOut: Number(o[2]), amountIn: o[3], minAmountOut: o[4] };
  }));
  const marketAbi = (await artifact('UniswapV3Route')).abi;
  const markets = await Promise.all(Array.from({ length: Number(await read('marketCount')) }, async (_, i) => {
    const market = await read('markets', [BigInt(i)]);
    const endpoints = await Promise.all(['token0', 'token1'].map(functionName => client.readContract({ address: market, abi: marketAbi, functionName })));
    return { token0: tokens.findIndex(t => t.toLowerCase() === endpoints[0].toLowerCase()), token1: tokens.findIndex(t => t.toLowerCase() === endpoints[1].toLowerCase()) };
  }));
  const bands=[0n];
  for(let i=1;i<count;i++) {
    const oracle=await read('oracles',[BigInt(i)]);
    bands.push(await client.readContract({address:oracle,abi:marketAbi,functionName:'maxDeviationBps'}));
  }
  let request;
  const result = await solve({ orders, prices, markets, bands, simulate: async (fractions, routes, proposed) => {
    try { request = (await client.simulateContract({ address, abi, functionName: 'settleAtPrices', args: [batch, [...proposed,...Array(8-proposed.length).fill(0n)], fractions, routes] })).request;return true; }
    catch (error) { if (error.walk?.(e => e instanceof ContractFunctionRevertedError)) return false;throw error; }
  }});
  if (result.fractions && env.SUBMIT === '1') {
    if (!env.PRIVATE_KEY) throw new Error('PRIVATE_KEY is required for SUBMIT=1');
    const account = privateKeyToAccount(env.PRIVATE_KEY);
    const wallet = createWalletClient({ account, transport: http(env.RPC_URL || 'http://127.0.0.1:8545') });
    const hash = await wallet.writeContract({ ...request, account, chain: null });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`settlement reverted: ${hash}`);
    result.transactionHash = hash;
  }
  return { batch, ...result };
}
export async function action(command,env=process.env) {
  if(command==='solve'||command==='--once'||!command) return run(env);
  if(command==='deploy') {
    const {deploy}=await import('./deploy.mjs');return deploy(JSON.parse(await readFile(env.CONFIG_FILE,'utf8')),env);
  }
  if(command==='discover') {
    const {discoverPaths}=await import('./solver.mjs');const config=JSON.parse(await readFile(env.CONFIG_FILE,'utf8'));
    return discoverPaths(config.pools,config.input,config.output);
  }
  if(!['admit','reveal','expire','slash'].includes(command)) throw new Error('expected solve, discover, deploy, admit, reveal, expire, or slash');
  const abi=(await artifact('GlobalAuction')).abi,address=env.GLOBAL_AUCTION;
  if(!address || !env.PRIVATE_KEY) throw new Error('GLOBAL_AUCTION and PRIVATE_KEY are required');
  const account=privateKeyToAccount(env.PRIVATE_KEY),transport=http(env.RPC_URL||'http://127.0.0.1:8545');
  const client=createPublicClient({transport});let functionName=command,args;
  if(command==='admit') {
    const state=JSON.parse(await readFile(env.STATE_FILE,'utf8'));
    const preparation=JSON.parse(await readFile(env.PREPARATION_PROOF,'utf8'));
    const online=JSON.parse(await readFile(env.ONLINE_PROOF,'utf8'));
    args=[BigInt(env.BATCH),state.orderHash,state.ciphertext,state.keyCommitment,state.root,encodeAbiParameters([{type:'bytes'},{type:'bytes'}],[preparation.proof,online.proof])];
  } else if(command==='reveal') {
    const revealed=JSON.parse(await readFile(env.ORDER_FILE,'utf8'));
    const o={...revealed.order,amountIn:BigInt(revealed.order.amountIn),minAmountOut:BigInt(revealed.order.minAmountOut)};
    args=[BigInt(env.COMMIT_ID),o,revealed.salt];
  } else if(command==='slash') {functionName='slashUnrevealed';args=[BigInt(env.COMMIT_ID)];}
  else args=[BigInt(env.BATCH)];
  const {request}=await client.simulateContract({address,abi,functionName,args,account});
  if(env.SUBMIT!=='1') return {command,simulation:'passed'};
  const wallet=createWalletClient({account,transport}),hash=await wallet.writeContract({...request,chain:null});
  const receipt=await client.waitForTransactionReceipt({hash});
  if(receipt.status!=='success') throw new Error(`transaction reverted: ${hash}`);
  return {command,transactionHash:hash};
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  action(process.argv[2]).then(result => console.log(JSON.stringify(result, (_, v) => typeof v === 'bigint' ? v.toString() : v)))
    .catch(error => { console.error(error.shortMessage || error.message);process.exitCode = 1; });
}
