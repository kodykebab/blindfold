// Tests import the pure client modules (../client/*.mjs) as the bundle does. esbuild finds their `viem` through
// nodePaths; this hook does the same for node --test, so packages/client needs no install of its own.
import { register } from 'node:module'
register('data:text/javascript,' + encodeURIComponent(`
  const fallback = ${JSON.stringify(new URL('../package.json', import.meta.url).href)}
  export async function resolve(spec, ctx, next) {
    try { return await next(spec, ctx) }
    catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND' || /^[./]/.test(spec)) throw e; return next(spec, { ...ctx, parentURL: fallback }) }
  }`))
