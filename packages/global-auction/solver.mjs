export const ONE = (1n << 128n) - 1n;
const ceil = (a, b) => (a + b - 1n) / b;
const gcd = (a, b) => b ? gcd(b, a % b) : a;

export function allocation(order, fraction, prices) {
  if (!order || fraction === 0n) return { input: 0n, output: 0n };
  const { amountIn: amount, minAmountOut: minimum, tokenIn: i, tokenOut: j } = order;
  let input = amount * fraction / ONE;
  let output = input * prices[i] / prices[j];
  if (output < ceil(minimum * input, amount)) {
    const lot = amount / gcd(amount, minimum);
    input = input / lot * lot;
    output = input * prices[i] / prices[j];
  }
  if (output === 0n) input = 0n;
  return { input, output };
}

export function totals(orders, fractions, prices) {
  const incoming = prices.map(() => 0n), owed = prices.map(() => 0n);
  const fills = orders.map((order, i) => allocation(order, fractions[i], prices));
  for (let i = 0; i < orders.length; i++) {
    if (!orders[i]) continue;
    incoming[orders[i].tokenIn] += fills[i].input;
    owed[orders[i].tokenOut] += fills[i].output;
  }
  return { incoming, owed, fills };
}

// Bounded discovery of simple authenticated pool paths. Deploy selected paths as UniswapV3Route.
export function discoverPaths(edges, input, output, maxHops = 3) {
  if (!Number.isInteger(maxHops) || maxHops < 1 || maxHops > 3 || edges.length > 64) throw new Error('path search bounds');
  const result = [];
  function visit(token, path, seen) {
    if (path.length >= maxHops) return;
    for (const edge of edges) {
      const next = edge.token0 === token ? edge.token1 : edge.token1 === token ? edge.token0 : null;
      if (next === null || seen.has(next)) continue;
      const candidate = [...path, edge];
      if (next === output) result.push(candidate);
      else visit(next, candidate, new Set([...seen, next]));
    }
  }
  if (input !== output) visit(input, [], new Set([input]));
  return result;
}

// Groups are whole directed-pair limit classes, sorted from better to worse.
export function groups(orders, prices) {
  const result = [];
  orders.forEach((o, index) => {
    if (!o || prices[o.tokenIn] === 0n || prices[o.tokenOut] === 0n || o.amountIn * prices[o.tokenIn] / prices[o.tokenOut] < o.minAmountOut) return;
    let group = result.find(g => g.order.tokenIn === o.tokenIn && g.order.tokenOut === o.tokenOut
      && g.order.minAmountOut * o.amountIn === o.minAmountOut * g.order.amountIn);
    if (!group) result.push(group = { order: o, indices: [] });
    group.indices.push(index);
  });
  return result.sort((a, b) => a.order.tokenIn - b.order.tokenIn || a.order.tokenOut - b.order.tokenOut
    || (a.order.minAmountOut * b.order.amountIn < b.order.minAmountOut * a.order.amountIn ? -1 : 1));
}

// Build a circulation in common value units. Each directed pair exposes its best
// unsaturated limit class first, preserving price priority across overlapping cycles.
export function cycleFractions(orders, prices) {
  const gs=groups(orders,prices);
  const capacity=gs.map(g=>g.indices.reduce((sum,i)=>sum+orders[i].amountIn*prices[orders[i].tokenIn],0n));
  const used=gs.map(()=>0n);
  for(let iteration=0;iteration<gs.length;iteration++) {
    const pairs=new Set(),active=[];
    for(let i=0;i<gs.length;i++) {
      if(used[i]===capacity[i])continue;
      const o=gs[i].order,key=`${o.tokenIn}:${o.tokenOut}`;
      if(!pairs.has(key)){pairs.add(key);active.push(i);}
    }
    let explored=0;
    function visit(start,token,seen,path) {
      if(++explored>10000)return null;
      for(const i of active) {
        const o=gs[i].order;if(o.tokenIn!==token)continue;
        if(o.tokenOut===start && path.length>0)return [...path,i];
        if(!seen.has(o.tokenOut)) {
          const found=visit(start,o.tokenOut,new Set([...seen,o.tokenOut]),[...path,i]);
          if(found)return found;
        }
      }
      return null;
    }
    let cycle;
    for(let token=0;token<prices.length && !cycle;token++)cycle=visit(token,token,new Set([token]),[]);
    if(!cycle)break;
    const value=cycle.reduce((minimum,i)=>{const free=capacity[i]-used[i];return minimum===null||free<minimum?free:minimum;},null);
    for(const i of cycle)used[i]+=value;
  }
  const fractions=orders.map(()=>0n);
  gs.forEach((g,i)=>g.indices.forEach(index=>fractions[index]=ceil(used[i]*ONE,capacity[i])));
  return fractions;
}

// Search registered adapters, never arbitrary calldata. Routes consume only measured surplus.
function routePlans(state, prices, markets, maxPlans) {
  const results = [], budget = { nodes: 0 };
  function visit(available, routes) {
    if (++budget.nodes > maxPlans * 64 || results.length >= maxPlans || routes.length > 64) return;
    const output = available.findIndex((v, i) => v < state.owed[i]);
    if (output === -1) { results.push(routes); return; }
    for (let input = 0; input < available.length; input++) {
      const surplus = available[input] - state.owed[input];
      if (surplus <= 0n) continue;
      for (let market = 0; market < markets.length; market++) {
        const m = markets[market];
        if (!((m.token0 === input && m.token1 === output) || (m.token1 === input && m.token0 === output))) continue;
        const deficit = state.owed[output] - available[output];
        // Try exact reference sizing, then the complete surplus to cover venue fees.
        const exact = ceil(deficit * prices[output], prices[input]);
        for (const amount of new Set([exact < surplus ? exact : surplus, surplus])) {
          if (amount === 0n || amount >= 1n << 128n) continue;
          const expected = amount * prices[input] / prices[output];
          if (expected === 0n) continue;
          const minimum = expected < deficit ? expected : deficit;
          if (minimum >= 1n << 128n) continue;
          const next = [...available]; next[input] -= amount; next[output] += minimum;
          visit(next, [...routes, { input, output, market, amount, minimum }]);
        }
      }
    }
  }
  visit([...state.incoming], []);
  return results;
}

/** Deterministic bounded search. Successful candidates must pass full onchain simulation.
 * Exhausting this budget means "no candidate found", never "no feasible solution".
 */
async function solveFixed({ orders, prices, markets = [], simulate, maxSimulations = 256 }) {
  if (orders.length > 64 || prices.length > 8 || prices[0] <= 0n || prices.some(p => p < 0n) || markets.length > 64) throw new Error('auction bounds');
  const gs = groups(orders, prices);
  let simulations = 0;
  const attempt = async fractions => {
    const state = totals(orders, fractions, prices);
    if (!state.fills.some(f => f.input)) return;
    for (const routes of routePlans(state, prices, markets, Math.min(32, maxSimulations - simulations))) {
      if (simulations >= maxSimulations) return;
      simulations++;
      if (await simulate(fractions, routes)) return { fractions, routes, simulations };
    }
  };
  const full = orders.map(() => 0n);
  gs.forEach(g => g.indices.forEach(i => full[i] = ONE));
  let found = await attempt(full); if (found) return found;
  const circulation=cycleFractions(orders,prices);
  if(!circulation.every((v,i)=>v===full[i])) {found=await attempt(circulation);if(found)return found;}
  // Each directed pair has at most one marginal class; worse classes are removed together.
  for (let gi = gs.length - 1; gi >= 0 && simulations < maxSimulations; gi--) {
    const g = gs[gi], base = [...full];
    for (let worse = gi + 1; worse < gs.length; worse++) {
      if (gs[worse].order.tokenIn === g.order.tokenIn && gs[worse].order.tokenOut === g.order.tokenOut)
        gs[worse].indices.forEach(i => base[i] = 0n);
    }
    const candidates = new Set([0n]);
    // Net-budget breakpoints plus a bounded grid; integer arithmetic matches settlement.
    const t = totals(orders, base, prices);
    const groupInput = g.indices.reduce((sum, i) => sum + orders[i].amountIn, 0n);
    const groupOutput = g.indices.reduce((sum, i) => sum + orders[i].amountIn * prices[g.order.tokenIn] / prices[g.order.tokenOut], 0n);
    if (groupInput) {
      const need = t.owed[g.order.tokenIn] - (t.incoming[g.order.tokenIn] - groupInput);
      if (need >= 0n && need <= groupInput) candidates.add(ceil(need * ONE, groupInput));
    }
    if (groupOutput) {
      const budget = t.incoming[g.order.tokenOut] - (t.owed[g.order.tokenOut] - groupOutput);
      if (budget >= 0n && budget <= groupOutput) candidates.add(budget * ONE / groupOutput);
    }
    for (let part = 15n; part >= 1n; part--) candidates.add(ONE * part / 16n);
    for (const fraction of [...candidates].sort((a,b) => a > b ? -1 : a < b ? 1 : 0)) {
      const f = [...base];g.indices.forEach(i => f[i] = fraction);
      found = await attempt(f);if (found) return found;
      if (simulations >= maxSimulations) break;
    }
  }
  return { fractions: null, routes: null, simulations, reason: 'search exhausted; batch may still be feasible' };
}

/** Price adjustments remain one globally consistent vector, bounded per token by onchain oracle configuration. */
export async function solve(options) {
  const {prices,orders,bands=prices.map(()=>0n)}=options;
  const vectors=[prices];
  const full=orders.map(o=>o && prices[o.tokenIn]>0n && prices[o.tokenOut]>0n && o.amountIn*prices[o.tokenIn]/prices[o.tokenOut]>=o.minAmountOut?ONE:0n);
  const state=totals(orders,full,prices);
  for(const strength of [5000n,10000n]) {
    const proposed=prices.map((p,i)=>{
      if(i===0) return p;
      const delta=p*BigInt(bands[i]||0)/10000n*strength/10000n;
      return state.incoming[i]>state.owed[i]?p-delta:state.incoming[i]<state.owed[i]?p+delta:p;
    });
    if(proposed.every((p,i)=>p>0n || prices[i]===0n) && !vectors.some(v=>v.every((p,i)=>p===proposed[i])))vectors.push(proposed);
  }
  let simulations=0;
  const limit=options.maxSimulations??256;
  for(let i=0;i<vectors.length;i++) {
    const budget=Math.max(0,Math.floor((limit-simulations)/(vectors.length-i)));
    const result=await solveFixed({...options,prices:vectors[i],maxSimulations:budget,simulate:(f,r)=>options.simulate(f,r,vectors[i])});
    simulations+=result.simulations;
    if(result.fractions)return {...result,prices:vectors[i],simulations};
  }
  return {fractions:null,routes:null,simulations,reason:'search exhausted; batch may still be feasible'};
}
