// haveibeensandwiched MVP. Env: PORT (3100), ETH_RPC, ETHERSCAN_API_KEY (address lookups and v4 pricing; npm start loads ../../.env), OFFLINE=1 (serve fixtures.json only).
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { check } from './check.mjs'

const PORT = Number(process.env.PORT || 3100)
const page = readFileSync(new URL('./index.html', import.meta.url))

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/api/check') {
    let body, code = 200
    try { body = await check(url.searchParams.get('q')) } catch (e) { code = 502; body = { error: e.message } }
    res.writeHead(code, { 'content-type': 'application/json' })
    return res.end(JSON.stringify(body))
  }
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(page) }
  res.writeHead(404).end()
}).listen(PORT, () => console.log(`haveibeensandwiched on http://localhost:${PORT}`))
