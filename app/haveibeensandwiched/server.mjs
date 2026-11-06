import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { check } from './check.mjs'
import { createJobs } from './trading-server.mjs'
import { loadHistory } from './history.mjs'
import { loadCourt } from './court-view.mjs'

const PORT = Number(process.env.PORT || 3100)
const pages = new Map(['/index.html', '/trade.html', '/trade.css', '/trade.mjs', '/status.mjs', '/job-store.mjs', '/wallet-view.mjs'].map((p) => [p, readFileSync(new URL(`.${p}`, import.meta.url))]))
const jobs = createJobs()
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
createServer(async (req, res) => {
  const host = req.headers.host
  if (![ `127.0.0.1:${PORT}`, `localhost:${PORT}` ].includes(host)) return json(res, 403, { error: 'Invalid host' })
  const url = new URL(req.url, `http://${host}`)
  if (url.pathname === '/api/history' && req.method === 'GET') return json(res, 200, await loadHistory())
  if (url.pathname === '/api/court' && req.method === 'GET') {
    return json(res, 200, await loadCourt())
  }
  if (url.pathname === '/api/check' && req.method === 'GET') {
    try { return json(res, 200, await check(url.searchParams.get('q'))) } catch (e) { return json(res, 502, { error: e.message }) }
  }
  if (url.pathname === '/api/trade' && req.method === 'POST') {
    if (req.headers.origin !== `http://${host}` || req.headers['content-type'] !== 'application/json' || req.headers['x-blindfold-request'] !== '1') return json(res, 403, { error: 'Invalid origin' })
    let body = ''
    try {
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 1_010_000) throw Error('Request too large') }
      return json(res, 202, { id: jobs.start(JSON.parse(body)) })
    } catch (e) { return json(res, 400, { error: e.message }) }
  }
  if (url.pathname.startsWith('/api/trade/') && req.method === 'GET') {
    const job = jobs.get(url.pathname.slice('/api/trade/'.length))
    return job ? json(res, 200, job) : json(res, 404, { error: 'Job not found' })
  }
  const path = url.pathname === '/' ? '/index.html' : url.pathname === '/trade' ? '/trade.html' : url.pathname
  if (req.method === 'GET' && pages.has(path)) {
    const type = path.endsWith('.css') ? 'text/css' : path.endsWith('.mjs') ? 'text/javascript' : 'text/html'
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); return res.end(pages.get(path))
  }
  res.writeHead(404).end()
}).listen(PORT, '127.0.0.1', () => console.log(`Blindfold on http://127.0.0.1:${PORT}`))
