import { limits } from './limits.ts'
import { createServer } from 'node:http'
import { Database } from './database.ts'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { AuthApi } from './auth.ts'
import { canonicalPath } from './http.ts'
import { deletionHealth } from './deletion-health.ts'
import { clientIpPolicy } from './client-ip.ts'

const development = process.env.NODE_ENV === 'development'
const apiOrigin = process.env.API_ORIGIN ?? 'https://api.envhandoff.mabyko.com'
const clientIp = clientIpPolicy(process.env.CLOUDFLARE_ORIGIN_SECRET)
let db: Database
try {
  db = new Database(process.env.DATABASE_URL ?? '')
  await db.migrate()
} catch {
  console.error('PostgreSQL startup failed. Check DATABASE_URL and run docker compose up -d --wait postgres for local development.')
  process.exit(1)
}
if (!development && !process.env.DELETION_LEDGER_PATH) {
  console.error('DELETION_LEDGER_PATH is required on an independent durable volume. Initialize it explicitly before startup.');
  await db.close(); process.exit(1)
}
if (process.env.PRO_ACCEPT_NEW_TRANSFERS !== undefined && !['true', 'false'].includes(process.env.PRO_ACCEPT_NEW_TRANSFERS)) {
  console.error('PRO_ACCEPT_NEW_TRANSFERS must be true or false.');
  await db.close(); process.exit(1)
}
const auth = new AuthApi(db, {
  operatorGithubId: process.env.PRO_OPERATOR_GITHUB_ID,
  acceptNewTransfers: process.env.PRO_ACCEPT_NEW_TRANSFERS !== 'false',
  development, apiOrigin, webOrigin: process.env.WEB_ORIGIN ?? '',
  clientId: process.env.GITHUB_CLIENT_ID ?? '', clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '',
  totpEncryptionKey: process.env.TOTP_ENCRYPTION_KEY,
  deletionLedgerPath: process.env.DELETION_LEDGER_PATH ?? (development ? '.data/deletions' : undefined),
  fileStoragePath: process.env.FILE_STORAGE_PATH ?? (development ? '.data/objects' : undefined),
})

// ponytail: single-process beta limit; use a shared edge limiter before multiple API instances.
const attempts = new Map<string, { count: number; until: number }>()
const server = createServer({ maxHeaderSize: 8192, requestTimeout: 120_000, headersTimeout: 10_000 }, async (incoming, outgoing) => {
  outgoing.setTimeout(120_000, () => outgoing.destroy())
  outgoing.setHeader('cache-control', 'no-store')
  outgoing.setHeader('referrer-policy', 'no-referrer')
  try {
    const target = incoming.url ?? '', path = canonicalPath(target)
    if (!path || incoming.headers.host !== new URL(apiOrigin).host) {
      outgoing.writeHead(400).end(); return
    }
    const ip = clientIp(incoming.socket.remoteAddress, incoming.headers, incoming.method, path)
    if (!ip) { outgoing.writeHead(403, { connection: 'close' }).end(); return }
    if (incoming.headers.origin && incoming.headers.origin === process.env.WEB_ORIGIN) {
      outgoing.setHeader('access-control-allow-origin', incoming.headers.origin)
      outgoing.setHeader('access-control-allow-credentials', 'true')
      outgoing.setHeader('access-control-expose-headers', 'Retry-After')
      outgoing.setHeader('vary', 'Origin')
    }
    const jsonRequest = path === '/auth/account/remove' || ['/organizations', '/security', '/shares'].some(prefix => path === prefix || path.startsWith(prefix + '/'))
    if (!jsonRequest && (incoming.headers['transfer-encoding'] || (incoming.headers['content-length'] && incoming.headers['content-length'] !== '0'))) {
      outgoing.writeHead(413, { connection: 'close' }).end(); return
    }
    if (!jsonRequest || incoming.method !== 'POST') incoming.resume()
    if (path.startsWith('/shares/') && incoming.method !== 'OPTIONS') {
      const now = Date.now(), address = 'share:' + ip
      for (const [ip, attempt] of attempts) if (attempt.until <= now) attempts.delete(ip)
      const attempt = attempts.get(address) ?? { count: 0, until: now + 60_000 }
      if (attempt.count >= limits.ipRequestsPerMinute || (!attempts.has(address) && attempts.size >= 1000)) {
        outgoing.writeHead(429, { 'retry-after': '60' }).end(); return
      }
      attempt.count++; attempts.set(address, attempt)
    }
    if (!path.startsWith('/shares/') && (path === '/auth/github/start' || (jsonRequest && incoming.method === 'POST'))) {
      const transferRequest = /^\/organizations\/[^/]+\/shares(\/|$)/.test(path) || /^\/organizations\/[^/]+\/requests\/[^/]+\/(transfer|uploads)(\/|$)/.test(path)
      const limit = transferRequest ? 120 : 20
      const now = Date.now(), address = (transferRequest ? 'transfer:' : 'other:') + ip
      for (const [ip, attempt] of attempts) if (attempt.until <= now) attempts.delete(ip)
      const attempt = attempts.get(address) ?? { count: 0, until: now + 10 * 60_000 }
      if (attempt.count >= limit || (!attempts.has(address) && attempts.size >= 1000)) {
        outgoing.writeHead(429, { 'retry-after': '600' }).end(); return
      }
      attempt.count++; attempts.set(address, attempt)
    }
    const headers = new Headers()
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!)
    const init = { method: incoming.method, headers, ...(jsonRequest && incoming.method === 'POST' ? { body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>, duplex: 'half' } : {}) }
    const response = await auth.handle(new Request(apiOrigin + target, init))
    // Close rejected uploads instead of buffering or draining an unbounded body.
    if (!incoming.readableEnded) outgoing.setHeader('connection', 'close')
    for (const [key, value] of response.headers) if (key !== 'set-cookie') outgoing.setHeader(key, value)
    const cookies = response.headers.getSetCookie()
    if (cookies.length) outgoing.setHeader('set-cookie', cookies)
    outgoing.writeHead(response.status)
    if (response.body) await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), outgoing)
    else outgoing.end()
  } catch {
    if (!outgoing.headersSent) outgoing.writeHead(503).end()
    else outgoing.destroy()
  }
})
server.maxConnections = 128
try { await auth.prune() } catch {
  console.error('Startup maintenance failed. Keep traffic stopped and verify the independent deletion ledger and database.');
  await db.close(); process.exit(1)
}
let maintaining = false
const cleanup = setInterval(() => {
  if (maintaining) return
  maintaining = true
  void (async () => {
    try { await auth.prune() }
    finally {
      const health = await deletionHealth(db)
      if (health.status === 'delayed') console.error(JSON.stringify({ event: 'deletion_delayed', ...health }))
    }
  })().catch(() => console.error('API maintenance or deletion health check failed')).finally(() => { maintaining = false })
}, 60_000)
cleanup.unref()
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(`API server could not start (${error.code ?? 'unknown'})`)
  clearInterval(cleanup); void db.close(); process.exitCode = 1
})
server.listen(Number(process.env.PORT ?? (development ? 3001 : 3000)), development ? 'localhost' : '0.0.0.0', () => {
  console.log(`EnvHandoff API ready: ${apiOrigin}`)
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  clearInterval(cleanup)
  server.close(() => { void db.close().then(() => process.exit(0)) })
})
