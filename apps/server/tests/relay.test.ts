import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { RELAY } from '../../../packages/protocol/src/index.ts'

// These are protocol integration tests against a real local workerd, using public fake bytes.
let worker: ReturnType<typeof spawn>
let directory = ''
let base = ''
let output = ''
const origin = 'http://localhost:5173'
const sockets = new Set<WebSocket>()

before(
  async () => {
    const listener = createServer()
    listener.listen(0, '127.0.0.1')
    await once(listener, 'listening')
    const address = listener.address()
    assert(address && typeof address !== 'string')
    const port = address.port
    await new Promise<void>((resolve) => listener.close(() => resolve()))
    directory = await mkdtemp(join(tmpdir(), 'envhandoff-relay-test-'))
    base = `http://127.0.0.1:${port}`
    worker = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)),
        'dev',
        '--local',
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--inspector-port',
        '0',
        '--persist-to',
        directory,
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    worker.stdout?.on('data', (chunk) => {
      output = (output + chunk).slice(-8000)
    })
    worker.stderr?.on('data', (chunk) => {
      output = (output + chunk).slice(-8000)
    })
    for (let i = 0; i < 150; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) return
      } catch {
        /* Starting. */
      }
      if (worker.exitCode !== null) break
      await delay(100)
    }
    throw new Error(`Local Worker did not start: ${output}`)
  },
  { timeout: 25_000 },
)

after(async () => {
  for (const socket of sockets) socket.terminate()
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM')
    const timeout = setTimeout(() => worker.kill('SIGKILL'), 5000)
    await once(worker, 'exit')
    clearTimeout(timeout)
  }
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function create(ip = '192.0.2.1') {
  const response = await fetch(`${base}/api/relay`, {
    method: 'POST',
    headers: { Origin: origin, 'CF-Connecting-IP': ip },
  })
  assert.equal(response.status, 200, `create: ${await response.clone().text()}`)
  return response.json()
}

async function connect(
  session: { id: string; senderToken: string; receiverToken: string },
  role: 'sender' | 'receiver',
  token = session[`${role}Token`],
) {
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/relay/${session.id}`, {
    headers: { Origin: origin },
  })
  sockets.add(socket)
  const messages: (Record<string, unknown> | Buffer)[] = []
  const subscribers = new Set<() => void>()
  socket.on('message', (data, binary) => {
    messages.push(binary ? Buffer.from(data as Buffer) : JSON.parse(data.toString()))
    for (const notify of subscribers) notify()
  })
  socket.on('error', () => {
    /* Fail the relevant wait instead of an unhandled event. */
  })
  const closed = new Promise<void>((resolve) =>
    socket.once('close', () => {
      sockets.delete(socket)
      resolve()
    }),
  )
  function wait(type: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        subscribers.delete(check)
        reject(new Error(`Missing ${type}: ${JSON.stringify(messages)}`))
      }, 4000)
      function check() {
        const index = messages.findIndex((message) =>
          type === 'binary' ? Buffer.isBuffer(message) : !Buffer.isBuffer(message) && message.type === type,
        )
        if (index < 0) return
        clearTimeout(timer)
        subscribers.delete(check)
        resolve(messages.splice(index, 1)[0])
      }
      subscribers.add(check)
      check()
    })
  }
  await once(socket, 'open')
  const send = (message: object | Buffer) =>
    socket.send(Buffer.isBuffer(message) ? message : JSON.stringify(message))
  send({ type: 'auth', role, token })
  return { socket, messages, closed, wait, send }
}

async function pair() {
  const session = await create()
  const sender = await connect(session, 'sender')
  const receiver = await connect(session, 'receiver')
  await sender.wait('ready')
  await receiver.wait('ready')
  const peer = await sender.wait('peer')
  assert.deepEqual(await receiver.wait('peer'), peer)
  assert.match(peer.verification, /^\d{6}$/)
  return { session, sender, receiver, peer }
}

async function upgradeStatus(id: string, requestOrigin: string) {
  return new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/relay/${id}`, {
      headers: { Origin: requestOrigin },
    })
    socket.on('error', reject)
    socket.on('unexpected-response', (_request, response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    socket.on('open', () => {
      socket.terminate()
      reject(new Error('Unexpected accepted upgrade'))
    })
  })
}

test('origin and route checks reject unintended callers', async () => {
  assert.equal((await fetch(`${base}/api/relay`, { method: 'POST' })).status, 403)
  assert.equal(
    (await fetch(`${base}/api/relay`, { method: 'POST', headers: { Origin: 'https://unrelated.example' } }))
      .status,
    403,
  )
  assert.equal(
    (await fetch(`${base}/api/relay?token=not-allowed`, { method: 'POST', headers: { Origin: origin } }))
      .status,
    400,
  )
  const session = await create()
  assert.equal(await upgradeStatus(session.id, 'https://unrelated.example'), 403)
  const sender = await connect(session, 'sender')
  await sender.wait('ready')
  sender.send({ type: 'cancel' })
  await sender.closed
})

test('rejects binary before approval without forwarding it', async () => {
  const { sender, receiver } = await pair()
  sender.send(Buffer.alloc(64))
  assert.equal((await sender.wait('error')).reason, 'PROTOCOL')
  assert.equal((await receiver.wait('error')).reason, 'PROTOCOL')
  assert.equal(receiver.messages.some(Buffer.isBuffer), false)
  await Promise.all([sender.closed, receiver.closed])
})

test('requires valid role tokens and rejects a second receiver without disrupting the pair', async () => {
  const { session, sender, receiver, peer } = await pair()
  const invalid = await connect(session, 'receiver', session.senderToken)
  assert.equal((await invalid.wait('error')).reason, 'AUTH')
  const extra = await connect(session, 'receiver')
  assert.equal((await extra.wait('error')).reason, 'OCCUPIED')
  await Promise.all([invalid.closed, extra.closed])
  sender.send({ type: 'approve', peerId: peer.peerId, total: 40 })
  await sender.wait('approved')
  await receiver.wait('approved')
  sender.send({ type: 'cancel' })
  assert.equal((await receiver.wait('error')).reason, 'CANCELLED')
})

test('transfers exact chunks with backpressure, then requires an explicit receipt and invalidates the link', async () => {
  const { session, sender, receiver, peer } = await pair()
  const payload = Buffer.alloc(RELAY.chunkBytes * 2 + 13)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251
  sender.send({ type: 'approve', peerId: peer.peerId, total: payload.length })
  await sender.wait('approved')
  await receiver.wait('approved')
  for (let offset = 0; offset < payload.length;) {
    const next = Math.min(payload.length, offset + RELAY.chunkBytes)
    sender.send(payload.subarray(offset, next))
    assert.deepEqual(await receiver.wait('binary'), payload.subarray(offset, next))
    assert.equal(
      sender.messages.some((message) => !Buffer.isBuffer(message) && message.type === 'progress'),
      false,
    )
    receiver.send({ type: 'chunk-ack', offset: next })
    assert.equal((await sender.wait('progress')).offset, next)
    assert.equal((await receiver.wait('progress')).offset, next)
    offset = next
  }
  await sender.wait('transferred')
  await receiver.wait('transferred')
  await delay(80)
  assert.equal(
    sender.messages.some((message) => !Buffer.isBuffer(message) && message.type === 'complete'),
    false,
  )
  assert.equal(sender.socket.readyState, WebSocket.OPEN)
  receiver.send({ type: 'receipt' })
  await sender.wait('complete')
  await receiver.wait('complete')
  await Promise.all([sender.closed, receiver.closed])
  assert.equal(await upgradeStatus(session.id, origin), 410)
})

test('rejects out-of-order acknowledgments and receipts before transfer', async () => {
  for (const message of [{ type: 'chunk-ack', offset: 40 }, { type: 'receipt' }]) {
    const { sender, receiver } = await pair()
    receiver.send(message)
    assert.equal((await sender.wait('error')).reason, 'PROTOCOL')
    await Promise.all([sender.closed, receiver.closed])
  }
})

test('rejects oversized transfers and invalid peer approval', async () => {
  for (const total of [39, RELAY.maxBytes + 1]) {
    const { sender, receiver, peer } = await pair()
    sender.send({ type: 'approve', peerId: peer.peerId, total })
    assert.equal((await receiver.wait('error')).reason, 'PROTOCOL')
    await Promise.all([sender.closed, receiver.closed])
  }
  const { sender, receiver } = await pair()
  sender.send({ type: 'approve', peerId: crypto.randomUUID(), total: 40 })
  assert.equal((await receiver.wait('error')).reason, 'PROTOCOL')
  await Promise.all([sender.closed, receiver.closed])
})

test('disconnect interrupts the counterpart and prevents reconnection', async () => {
  const { session, sender, receiver } = await pair()
  receiver.socket.close()
  assert.equal((await sender.wait('error')).reason, 'DISCONNECTED')
  await Promise.all([sender.closed, receiver.closed])
  assert.equal(await upgradeStatus(session.id, origin), 410)
})

test('rejects wrong chunk sizes and a second chunk before its acknowledgment', async () => {
  for (const early of [false, true]) {
    const { sender, receiver, peer } = await pair()
    sender.send({ type: 'approve', peerId: peer.peerId, total: RELAY.chunkBytes * 2 })
    await sender.wait('approved')
    await receiver.wait('approved')
    sender.send(Buffer.alloc(early ? RELAY.chunkBytes : RELAY.chunkBytes + 1))
    if (early) {
      await receiver.wait('binary')
      sender.send(Buffer.alloc(RELAY.chunkBytes))
    }
    assert.equal((await receiver.wait('error')).reason, 'PROTOCOL')
    await Promise.all([sender.closed, receiver.closed])
  }
})

test('limits room creation per caller', async () => {
  let accepted = 0
  for (let i = 0; i < 21; i++) {
    const response = await fetch(`${base}/api/relay`, {
      method: 'POST',
      headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.99' },
    })
    if (response.status === 200) accepted++
    else assert.equal(response.status, 429)
  }
  assert.equal(accepted, 20)
  assert.equal(
    (
      await fetch(`${base}/api/relay`, {
        method: 'POST',
        headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.99' },
      })
    ).status,
    429,
  )
})
