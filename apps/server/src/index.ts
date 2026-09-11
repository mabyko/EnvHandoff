import { DurableObject } from 'cloudflare:workers'
import { RELAY, isSessionId, parseClientMessage } from '@envhandoff/protocol'
import type { Role, ServerMessage } from '@envhandoff/protocol'

interface Env {
  RELAY: DurableObjectNamespace<RelayRoom>
  REQUEST_LIMITS: DurableObjectNamespace<RequestLimits>
  WEB_ORIGINS: string
}

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })
const token = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/health' && request.method === 'GET') return json({ ok: true })
    const creating = url.pathname === '/api/relay' && request.method === 'POST'
    const id = /^\/api\/relay\/([0-9a-f]{64})$/.exec(url.pathname)?.[1]
    const connecting =
      id &&
      isSessionId(id) &&
      request.method === 'GET' &&
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket'
    if (!creating && !connecting) return json({ error: 'NOT_FOUND' }, 404)
    if (url.search) return json({ error: 'INVALID_REQUEST' }, 400)
    const origin = request.headers.get('Origin')
    if (
      !origin ||
      !env.WEB_ORIGINS.split(',')
        .map((value) => value.trim())
        .includes(origin)
    )
      return json({ error: 'ORIGIN' }, 403)
    if (
      creating &&
      (Number(request.headers.get('Content-Length') || '0') !== 0 || request.headers.has('Transfer-Encoding'))
    )
      return json({ error: 'INVALID_REQUEST' }, 400)
    if (creating) await request.body?.cancel()

    const ip = request.headers.get('CF-Connecting-IP') || 'local'
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip))
    const bucket = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
    const limiter = env.REQUEST_LIMITS.get(env.REQUEST_LIMITS.idFromName(bucket))
    const limit = await limiter.fetch(`https://limits/${creating ? 'create' : 'connect'}`)
    if (limit.status !== 200) return json({ error: 'RATE_LIMIT' }, 429)
    if (creating) {
      const roomId = env.RELAY.newUniqueId()
      const response = await env.RELAY.get(roomId).fetch('https://room/create', { method: 'POST' })
      return json({ id: roomId.toString(), ...(await response.json<object>()) })
    }
    let roomId: DurableObjectId
    try {
      roomId = env.RELAY.idFromString(id!)
    } catch {
      return json({ error: 'INVALID_REQUEST' }, 400)
    }
    return env.RELAY.get(roomId).fetch(new Request('https://room/connect', request))
  },
} satisfies ExportedHandler<Env>

// Only counters are persisted. Rooms, connection tokens and ciphertext never enter storage.
export class RequestLimits extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const category = new URL(request.url).pathname === '/create' ? 'create' : 'connect'
    const allowed = await this.ctx.storage.transaction(async (storage) => {
      const now = Date.now()
      const stored = await storage.get<{ reset: number; create: number; connect: number }>('counter')
      const counter = stored && stored.reset > now ? stored : { reset: now + 60_000, create: 0, connect: 0 }
      if (counter[category] >= (category === 'create' ? 20 : 120)) return false
      counter[category]++
      await storage.put('counter', counter)
      await storage.setAlarm(counter.reset)
      return true
    })
    return new Response(null, { status: allowed ? 200 : 429 })
  }

  async alarm(): Promise<void> {
    const counter = await this.ctx.storage.get<{ reset: number }>('counter')
    if (counter && counter.reset > Date.now()) {
      await this.ctx.storage.setAlarm(counter.reset)
      return
    }
    await this.ctx.storage.deleteAll()
  }
}

export class RelayRoom extends DurableObject<Env> {
  private senderToken = ''
  private receiverToken = ''
  private expiresAt = 0
  private closed = false
  private sender?: WebSocket
  private receiver?: WebSocket
  private sockets = new Map<WebSocket, { role?: Role; timer: ReturnType<typeof setTimeout> }>()
  private lifetimeTimer: ReturnType<typeof setTimeout> | null = null
  private phaseTimer: ReturnType<typeof setTimeout> | null = null
  private peerId = ''
  private total = 0
  private offset = 0
  private pendingOffset = 0
  private awaitingReceipt = false

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/create' && request.method === 'POST' && !this.expiresAt) {
      this.senderToken = token()
      this.receiverToken = token()
      this.expiresAt = Date.now() + RELAY.lifetimeMs
      this.lifetimeTimer = setTimeout(() => this.finish('EXPIRED'), RELAY.lifetimeMs)
      return json({
        senderToken: this.senderToken,
        receiverToken: this.receiverToken,
        expiresAt: this.expiresAt,
      })
    }
    if (!this.expiresAt || this.closed || Date.now() >= this.expiresAt) return json({ error: 'EXPIRED' }, 410)
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
      return json({ error: 'INVALID_REQUEST' }, 400)
    if (this.sockets.size >= 4) return json({ error: 'BUSY' }, 429)
    const pair = new WebSocketPair()
    const [client, socket] = Object.values(pair)
    socket.accept()
    socket.binaryType = 'arraybuffer'
    const timer = setTimeout(() => this.reject(socket, 'AUTH'), RELAY.authMs)
    this.sockets.set(socket, { timer })
    socket.addEventListener('message', (event) => this.message(socket, event.data))
    socket.addEventListener('close', () => this.disconnected(socket))
    socket.addEventListener('error', () => this.disconnected(socket))
    return new Response(null, { status: 101, webSocket: client })
  }

  private send(socket: WebSocket | undefined, message: ServerMessage): void {
    if (!socket) return
    try {
      socket.send(JSON.stringify(message))
    } catch {
      this.finish('DISCONNECTED')
    }
  }

  private both(message: ServerMessage): void {
    this.send(this.sender, message)
    this.send(this.receiver, message)
  }

  private reject(socket: WebSocket, reason: string): void {
    const state = this.sockets.get(socket)
    if (state) clearTimeout(state.timer)
    this.sockets.delete(socket)
    try {
      socket.send(JSON.stringify({ type: 'error', reason }))
    } catch {
      /* Unauthenticated client left. */
    }
    try {
      socket.close(1008, reason)
    } catch {
      /* Already closed. */
    }
  }

  private disconnected(socket: WebSocket): void {
    const state = this.sockets.get(socket)
    if (state) clearTimeout(state.timer)
    this.sockets.delete(socket)
    if (state?.role && !this.closed) this.finish('DISCONNECTED')
  }

  private deadline(milliseconds: number): void {
    clearTimeout(this.phaseTimer)
    this.phaseTimer = setTimeout(() => this.finish('TIMEOUT'), milliseconds)
  }

  private message(socket: WebSocket, data: string | ArrayBuffer): void {
    if (this.closed) return
    if (Date.now() >= this.expiresAt) {
      this.finish('EXPIRED')
      return
    }
    const state = this.sockets.get(socket)
    if (!state) return
    if (!state.role) {
      const message = typeof data === 'string' ? parseClientMessage(data) : null
      if (
        message?.type !== 'auth' ||
        message.token !== (message.role === 'sender' ? this.senderToken : this.receiverToken)
      ) {
        this.reject(socket, 'AUTH')
        return
      }
      if (this[message.role]) {
        this.reject(socket, 'OCCUPIED')
        return
      }
      clearTimeout(state.timer)
      state.role = message.role
      this[message.role] = socket
      this.send(socket, { type: 'ready', role: message.role, expiresAt: this.expiresAt })
      if (this.sender && this.receiver) {
        this.peerId = crypto.randomUUID()
        const verification = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(
          6,
          '0',
        )
        this.both({ type: 'peer', peerId: this.peerId, verification })
      }
      return
    }
    if (typeof data !== 'string') {
      if (
        state.role !== 'sender' ||
        !this.total ||
        this.awaitingReceipt ||
        this.pendingOffset ||
        data.byteLength !== Math.min(RELAY.chunkBytes, this.total - this.offset)
      ) {
        this.finish('PROTOCOL')
        return
      }
      this.pendingOffset = this.offset + data.byteLength
      try {
        this.receiver!.send(data)
      } catch {
        this.finish('DISCONNECTED')
        return
      }
      this.deadline(RELAY.idleMs)
      return
    }
    const message = parseClientMessage(data)
    if (!message) {
      this.finish('PROTOCOL')
      return
    }
    if (message.type === 'cancel') {
      this.finish('CANCELLED')
      return
    }
    if (
      message.type === 'approve' &&
      state.role === 'sender' &&
      this.receiver &&
      !this.total &&
      this.peerId === message.peerId
    ) {
      this.total = message.total
      this.both({ type: 'approved', total: this.total })
      this.deadline(RELAY.idleMs)
      return
    }
    if (
      message.type === 'chunk-ack' &&
      state.role === 'receiver' &&
      this.pendingOffset &&
      message.offset === this.pendingOffset
    ) {
      this.offset = this.pendingOffset
      this.pendingOffset = 0
      this.both({ type: 'progress', offset: this.offset, total: this.total })
      if (this.offset === this.total) {
        this.awaitingReceipt = true
        this.both({ type: 'transferred' })
        this.deadline(RELAY.receiptMs)
      } else this.deadline(RELAY.idleMs)
      return
    }
    if (message.type === 'receipt' && state.role === 'receiver' && this.awaitingReceipt) {
      this.finish()
      return
    }
    this.finish('PROTOCOL')
  }

  private finish(reason?: string): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.lifetimeTimer)
    clearTimeout(this.phaseTimer)
    this.both(reason ? { type: 'error', reason } : { type: 'complete' })
    for (const [socket, state] of this.sockets) {
      clearTimeout(state.timer)
      try {
        socket.close(reason ? 1008 : 1000, reason || 'COMPLETE')
      } catch {
        /* Already closed. */
      }
    }
    this.sockets.clear()
    this.sender = this.receiver = undefined
    this.senderToken = this.receiverToken = ''
  }
}
