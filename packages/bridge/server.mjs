// Static server for the bridge page: http://localhost:4317 (DECISIONS.md D9). `npm start`; PORT overrides.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('./public/', import.meta.url))
const TYPES = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }
const HEADERS = {
  // data: images are EIP-6963 wallet icons; no framing, since this page triggers wallet prompts
  'content-security-policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

export function serve(port = 4317, host = 'localhost') {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const name = path === '/' ? 'index.html' : path.slice(1)
    // flat file names only: nothing outside public/ is reachable
    if (req.method !== 'GET' || !/^[a-z0-9-]+\.[a-z]+$/.test(name) || !TYPES[extname(name)]) return res.writeHead(404, HEADERS).end()
    try {
      const body = await readFile(join(ROOT, name))
      res.writeHead(200, { ...HEADERS, 'content-type': TYPES[extname(name)] }).end(body)
    } catch {
      res.writeHead(404, HEADERS).end()
    }
  })
  return new Promise((resolve, reject) => server.once('error', reject).listen(port, host, () => resolve(server)))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await serve(Number(process.env.PORT) || 4317)
  console.log(`bridge: http://localhost:${server.address().port}/`)
}
