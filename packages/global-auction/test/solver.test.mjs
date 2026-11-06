import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ONE, allocation, discoverPaths, solve, totals } from '../solver.mjs';
const order = (tokenIn,tokenOut,amountIn,minAmountOut=amountIn) => ({tokenIn,tokenOut,amountIn,minAmountOut});
const prices = [1n,1n,1n];
const balanced = (orders, p=prices) => async (f,r) => {
 const t=totals(orders,f,p);const available=[...t.incoming];
 for(const route of r) {if(available[route.input]-t.owed[route.input]<route.amount)return false;available[route.input]-=route.amount;available[route.output]+=route.amount;}
 return available.every((v,i)=>v>=t.owed[i]);
};
test('three-token cycle clears without routes',async()=>{const orders=[order(0,1,100n),order(1,2,100n),order(2,0,100n)];const r=await solve({orders,prices,simulate:balanced(orders)});assert.deepEqual(r.fractions,[ONE,ONE,ONE]);assert.deepEqual(r.routes,[]);});
test('uneven peer batch uses its budget breakpoint',async()=>{const orders=[order(0,1,100n),order(1,0,37n)];const r=await solve({orders,prices,simulate:balanced(orders)});assert.equal(allocation(orders[0],r.fractions[0],prices).input,37n);assert.equal(r.fractions[1],ONE);});
test('equal limits always have equal fractions',async()=>{const orders=[order(0,1,100n),order(0,1,100n),order(1,0,50n)];const r=await solve({orders,prices,simulate:balanced(orders)});assert.equal(r.fractions[0],r.fractions[1]);});
test('routes one-sided surplus through registered adapter',async()=>{const orders=[order(0,2,100n)];const r=await solve({orders,prices,markets:[{token0:0,token1:2}],simulate:balanced(orders)});assert.equal(r.routes.length,1);assert.equal(r.routes[0].amount,100n);});
test('tries another venue when simulation rejects the first',async()=>{const orders=[order(0,1,100n)];const r=await solve({orders,prices,markets:[{token0:0,token1:1},{token0:0,token1:1}],simulate:async(f,r)=>r[0].market===1});assert.equal(r.routes[0].market,1);});
test('bounded failure makes no infeasibility claim',async()=>{const r=await solve({orders:[order(0,1,100n)],prices,markets:[{token0:0,token1:1}],maxSimulations:3,simulate:async()=>false});assert.equal(r.fractions,null);assert.equal(r.simulations,3);assert.match(r.reason,/may still be feasible/);});
test('RPC failures propagate',async()=>{await assert.rejects(solve({orders:[order(0,1,100n),order(1,0,100n)],prices,simulate:async()=>{throw Error('RPC down')}}),/RPC down/);});
test('keeps valid coprime partials and drops violating dust',()=>{assert.deepEqual(allocation(order(0,1,1001n,900n),540n*ONE/1001n+1n,[9n,10n]),{input:540n,output:486n});assert.deepEqual(allocation(order(0,1,40n,39n),ONE/2n,[98n,100n]),{input:0n,output:0n});});
test('discovers direct and multi-hop paths without repeated tokens',()=>{const edges=[{token0:'A',token1:'B'},{token0:'B',token1:'C'},{token0:'C',token1:'D'},{token0:'A',token1:'D'}];assert.deepEqual(discoverPaths(edges,'A','D').map(p=>p.length).sort(),[1,3]);assert.equal(discoverPaths(edges,'D','A').length,2);assert.throws(()=>discoverPaths(edges,'A','D',4));});
test('fixed corpus of mixed-size cycles conserves every token',async()=>{for(let n=1n;n<=200n;n++){const orders=[order(0,1,n*3n),order(1,2,n*3n),order(2,0,n*3n)];const r=await solve({orders,prices,simulate:balanced(orders)});assert.ok(r.fractions);const t=totals(orders,r.fractions,prices);assert.deepEqual(t.incoming,t.owed);}});

test('bounded price vector covers venue fees without breaking minimums',async()=>{
 const orders=[order(1,2,10000n,9800n)];const p=[10000n,10000n,10000n];
 const result=await solve({orders,prices:p,bands:[0n,100n,100n],markets:[{token0:1,token1:2}],simulate:async(f,r,price)=>{
  const t=totals(orders,f,price);const available=[...t.incoming];for(const route of r){const out=route.amount*997n/1000n;if(out<route.minimum)return false;available[route.input]-=route.amount;available[route.output]+=out;}return available.every((v,i)=>v>=t.owed[i]);
 }});
 assert.ok(result.fractions);assert.ok(result.prices[1]<p[1]);assert.ok(result.prices[2]>p[2]);
 assert.ok(allocation(orders[0],result.fractions[0],result.prices).output>=9800n);
});

test('unavailable token does not block unrelated healthy pairs',async()=>{
 const orders=[order(0,1,100n),order(1,0,100n),order(0,2,100n)];const prices=[100n,100n,0n];
 const result=await solve({orders,prices,bands:[0n,100n,100n],simulate:balanced(orders,prices)});
 assert.deepEqual(result.fractions,[ONE,ONE,0n]);
});

test('uneven three-token cycle makes several groups partial atomically',async()=>{
 const orders=[order(0,1,100n),order(1,2,50n),order(2,0,25n)];
 const r=await solve({orders,prices,simulate:balanced(orders)});assert.ok(r.fractions);
 assert.deepEqual(totals(orders,r.fractions,prices).fills.map(f=>f.input),[25n,25n,25n]);
});
test('overlapping cycles respect the shared edge capacity and limit priority',async()=>{
 const orders=[order(0,1,100n,80n),order(0,1,50n,45n),order(1,2,150n),order(2,0,150n),order(0,2,20n),order(2,0,20n)];
 const r=await solve({orders,prices,simulate:balanced(orders)});assert.ok(r.fractions);
 assert.equal(r.fractions[0],ONE);const state=totals(orders,r.fractions,prices);assert.deepEqual(state.incoming,state.owed);
});
