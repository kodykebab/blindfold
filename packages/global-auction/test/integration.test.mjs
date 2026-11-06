import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { createPublicClient, createWalletClient, http, encodeAbiParameters, keccak256, stringToHex, padHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { artifact } from '../cli.mjs';
const exec = promisify(execFile);
const enabled = process.env.RUN_GLOBAL_INTEGRATION === '1';
test('actual CLI settles cycles and public routes from one shared vault', { skip: !enabled, timeout: 240000 }, async t => {
 const port = 23000 + Math.floor(Math.random()*2000);
 const anvil=spawn('anvil',['--port',String(port),'--silent'],{stdio:'ignore'});
 t.after(()=>anvil.kill('SIGTERM'));
 const rpc=`http://127.0.0.1:${port}`;
 const directory=await mkdtemp(join(tmpdir(),'global-cli-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const json=async(name,value)=>{const path=join(directory,name);await writeFile(path,JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v),{mode:0o600});return path;};
 const client=createPublicClient({transport:http(rpc,{retryCount:0})});
 const accounts=Array.from({length:3},(_,addressIndex)=>mnemonicToAccount('test test test test test test test test test test test junk',{addressIndex}));
 const wallet=createWalletClient({account:accounts[0],transport:http(rpc)});
 for(let i=0;;i++){try{await client.getChainId();break;}catch(e){if(i>100)throw e;await sleep(30);}}
 const receipt=async hash=>{for(let i=0;i<500;i++){try{return await client.getTransactionReceipt({hash});}catch(e){if(e.name!=='TransactionReceiptNotFoundError')throw e;await sleep(20);}}throw Error('receipt timeout');};
 const deploy=async(name,args=[],source=name)=>{const a=await artifact(name,source);const r=await receipt(await wallet.deployContract({abi:a.abi,bytecode:a.bytecode.object,args,chain:null}));assert.equal(r.status,'success');return {address:r.contractAddress,abi:a.abi};};
 const write=async(c,functionName,args=[],account=accounts[0])=>{const r=await receipt(await wallet.writeContract({...c,functionName,args,account,chain:null}));assert.equal(r.status,'success',functionName);return r;};
 const read=(c,functionName,args=[])=>client.readContract({...c,functionName,args});
 const warp=async time=>{await client.request({method:'evm_setNextBlockTimestamp',params:[Number(time)]});await client.request({method:'evm_mine'});};
 const tokens=[];for(let i=0;i<3;i++)tokens.push(await deploy('MockERC20',['Token','T',18]));tokens.sort((a,b)=>a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
 const vault=await deploy('BlindfoldVault');const verifier=await deploy('GlobalProofMock',[],'GlobalAuction.t');
 const now=(await client.getBlock()).timestamp,genesis=1692803367n,start=genesis+((now-genesis)/3n+400n)*3n;
 const g=await deploy('GlobalAuction',[{vault:vault.address,verifier:verifier.address,tokens:tokens.map(t=>t.address),start,batchLength:300,revealLength:12,settleLength:300,depositAmount:10n,commitFee:1n,bountyBps:2000,treasury:accounts[0].address,drandIdentity:keccak256(stringToHex('test'))}]);
 await write(vault,'setOperator',[g.address]);
 const configuredMarkets=[];
 for(const [i,j,oracle] of [[0,1,true],[0,2,true],[1,2,false]]){const m=await deploy('GlobalMarketMock',[g.address,tokens[i].address,tokens[j].address],'GlobalAuction.t');configuredMarkets.push(m);await write(g,'addMarket',[m.address,oracle]);for(const token of tokens)await write(token,'mint',[m.address,1000000n]);}
 await write(g,'sealConfiguration');
 for(const a of accounts)for(const token of tokens){await write(token,'mint',[a.address,100000n]);await write(token,'approve',[vault.address,100000n],a);await write(vault,'deposit',[token.address,100000n],a);}
 await warp(start);let snapshot=await client.request({method:'evm_snapshot'});
 const cli=async(command='solve',extra={},account=accounts[0])=>{const {stdout}=await exec(process.execPath,['cli.mjs',command],{cwd:new URL('..',import.meta.url),env:{...process.env,RPC_URL:rpc,GLOBAL_AUCTION:g.address,BATCH:'0',SUBMIT:'1',PRIVATE_KEY:'0x'+Buffer.from(account.getHdKey().privateKey).toString('hex'),...extra},timeout:45000});return JSON.parse(stdout);};
 for(const [name,spec] of [['cycle',[[0,1],[1,2],[2,0]]],['uneven cycle',[[0,1],[1,2],[2,0]]],['external forward',[[1,2]]],['external reverse',[[2,1]]],['venue fees',[[1,2]]],['expiry',[[0,1]]],['slash',[[0,1]]]]) {
  await t.test(name,async()=>{
   if(name!=='cycle'){assert.ok(await client.request({method:'evm_revert',params:[snapshot]}));snapshot=await client.request({method:'evm_snapshot'});}
   if(name==='venue fees')await write(configuredMarkets[2],'configure',[1n<<96n,false,false,30n]);
   const commitments=[];
   for(let i=0;i<spec.length;i++){
    const order={owner:accounts[i].address,tokenIn:spec[i][0],tokenOut:spec[i][1],amountIn:name==='venue fees'?10000n:name==='uneven cycle'?[100n,50n,25n][i]:100n,minAmountOut:name==='venue fees'?9800n:name==='uneven cycle'?[90n,45n,22n][i]:90n};const salt=padHex(`0x0${i+1}`,{size:32});
    const hash=await read(g,'orderHash',[0n,order,salt]),key=padHex('0x01',{size:32}),root=padHex(`0x0${i+2}`,{size:32}),ciphertext=stringToHex('ciphertext');
    const [p,q]=await read(g,'admissionStatements',[order.owner,0n,hash,key,root,keccak256(ciphertext)]);
    const state=await json(`state-${i}.json`,{orderHash:hash,ciphertext,keyCommitment:key,root});
    const prep=await json(`prep-${i}.json`,{proof:p}),online=await json(`online-${i}.json`,{proof:q});
    const admitted=await cli('admit',{STATE_FILE:state,PREPARATION_PROOF:prep,ONLINE_PROOF:online},accounts[i]);assert.ok(admitted.transactionHash);
    commitments.push({order,salt});
   }
   if(name==='expiry'||name==='slash') {
    await warp(await read(g,name==='expiry'?'settleCloses':'revealCloses',[0n]));
    assert.ok((await cli(name==='expiry'?'expire':'slash',{COMMIT_ID:'0'})).transactionHash);
    assert.equal(await read(vault,'openCommitments',[accounts[0].address]),0n);return;
   }
   await warp(await read(g,'revealOpens',[0n]));
   for(let i=0;i<commitments.length;i++){const orderFile=await json(`order-${i}.json`,commitments[i]);const revealed=await cli('reveal',{ORDER_FILE:orderFile,COMMIT_ID:String(i)});assert.ok(revealed.transactionHash);}
   await warp(await read(g,'revealCloses',[0n]));const result=await cli();assert.ok(result.transactionHash);assert.equal(await read(g,'finalized',[0n]),true);
   for(const a of accounts)assert.equal(await read(vault,'openCommitments',[a.address]),0n);
   for(const token of tokens)assert.equal(await read(vault,'balanceOf',[g.address,token.address]),0n);
  });
 }
 await t.test('deployment CLI authenticates routes and seals single-operator configuration',async()=>{
  const factory=await deploy('RouteFactoryMock',[],'UniswapV3Route.t'),routes=[];
  for(const index of [1,2]) {
   const pool=await deploy('RoutePoolMock',[tokens[0].address,tokens[index].address,factory.address],'UniswapV3Route.t');
   await write(factory,'setPool',[tokens[0].address,tokens[index].address,pool.address]);
   routes.push({path:[tokens[0].address,tokens[index].address],hops:[{pool:pool.address,minimumLiquidity:'1',maximumObservationAge:1800}],window:600,maximumDelay:600,deviationBps:100,priceOracle:true});
  }
  const second=await deploy('GlobalProofMock',[],'GlobalAuction.t');
  const current=(await client.getBlock()).timestamp;
  const config=await json('deploy.json',{chainId:31337,tokens:tokens.map(t=>t.address),factory:factory.address,preparationVerifier:verifier.address,onlineVerifier:second.address,start:String(genesis+((current-genesis)/3n+1000n)*3n),batchLength:300,revealLength:12,settleLength:300,depositAmount:'10',commitFee:'1',bountyBps:2000,treasury:accounts[0].address,routes});
  const result=await cli('deploy',{CONFIG_FILE:config});assert.equal(result.tokens.length,3);
  const deployed={address:result.globalAuction,abi:g.abi};assert.equal(await read(deployed,'configurationSealed'),true);
  assert.equal((await read({address:result.vault,abi:vault.abi},'operator')).toLowerCase(),result.globalAuction.toLowerCase());
 });

});
