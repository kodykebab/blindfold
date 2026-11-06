import { readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, createWalletClient, http, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { artifact } from './cli.mjs';

// Explicit deployment manifest; canonical pool authentication happens in each route constructor.
export async function deploy(config, env = process.env) {
  if (env.SUBMIT !== '1' || !env.PRIVATE_KEY) throw new Error('deployment requires SUBMIT=1 and PRIVATE_KEY');
  const account = privateKeyToAccount(env.PRIVATE_KEY);
  const transport = http(env.RPC_URL || 'http://127.0.0.1:8545');
  const client = createPublicClient({ transport });
  const wallet = createWalletClient({ account, transport });
  const chainId = await client.getChainId();
  if (chainId !== Number(config.chainId)) throw new Error('deployment chain does not match manifest');
  const tokens = config.tokens;
  if (!Array.isArray(tokens) || tokens.length < 2 || tokens.length > 8 || tokens.some((t,i) => !/^0x[0-9a-fA-F]{40}$/.test(t) || (i && BigInt(tokens[i-1]) >= BigInt(t)))) throw new Error('tokens must be sorted, unique addresses');
  const send = async parameters => {
    const hash = await wallet.writeContract({ ...parameters, account, chain: null });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`deployment configuration reverted: ${hash}`);
  };
  const make = async (name,args) => {
    const a = await artifact(name);
    const hash = await wallet.deployContract({ abi:a.abi,bytecode:a.bytecode.object,args,account,chain:null });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`deployment reverted: ${hash}`);
    return { address:receipt.contractAddress,abi:a.abi };
  };
  // Verifier contracts are generated from the reviewed global circuit/setup and supplied explicitly.
  for (const address of [config.preparationVerifier,config.onlineVerifier]) if (!(await client.getCode({address}))) throw new Error('missing circuit verifier code');
  const verifier=await make('GlobalAdmissionVerifier',[config.preparationVerifier,config.onlineVerifier]);
  const vault=await make('BlindfoldVault',[]);
  const identity=keccak256(stringToHex('52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'+'83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a'));
  const auction=await make('GlobalAuction',[{vault:vault.address,verifier:verifier.address,tokens,start:BigInt(config.start),batchLength:config.batchLength,revealLength:config.revealLength,settleLength:config.settleLength,depositAmount:BigInt(config.depositAmount),commitFee:BigInt(config.commitFee),bountyBps:config.bountyBps,treasury:config.treasury,drandIdentity:identity}]);
  await send({...vault,functionName:'setOperator',args:[auction.address]});
  const routes=[];
  for(const route of config.routes) {
    const adapter=await make('UniswapV3Route',[auction.address,config.factory,route.path,route.hops.map(h=>({...h,minimumLiquidity:BigInt(h.minimumLiquidity)})),route.window,route.maximumDelay,BigInt(route.deviationBps)]);
    await send({...auction,functionName:'addMarket',args:[adapter.address,route.priceOracle===true]});
    routes.push({...route,address:adapter.address});
  }
  await send({...auction,functionName:'sealConfiguration',args:[]});
  const manifest={version:1,chainId,deployBlock:String(await client.getBlockNumber()),vault:vault.address,globalAuction:auction.address,admissionVerifier:verifier.address,preparationVerifier:config.preparationVerifier,onlineVerifier:config.onlineVerifier,tokens,routes};
  if(env.DEPLOYMENT_OUT) await writeFile(env.DEPLOYMENT_OUT,JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}
