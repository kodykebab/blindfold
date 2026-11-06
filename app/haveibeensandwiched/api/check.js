// Vercel Function behind /api/check: the same lookup server.mjs serves locally.
import { check } from '../check.mjs'

export default async function handler(req, res) {
  try {
    const r = await check(req.query.q)
    // Let Vercel's CDN keep complete answers for 5 minutes, so repeat lookups don't spend RPC or Etherscan quota.
    if (!r.error && !r.failed) res.setHeader('Cache-Control', 'public, s-maxage=300')
    res.status(200).json(r)
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
}
