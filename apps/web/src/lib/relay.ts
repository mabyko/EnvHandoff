import { RELAY, isSessionId, isToken, parseServerMessage } from '@envhandoff/protocol'
import type { ClientMessage, Invitation, RelaySession, Role, ServerMessage } from '@envhandoff/protocol'

export function readInvitation(hash: string): Invitation | null {
  const parts = /^#receive\/([^/]+)\/([^/]+)$/.exec(hash)
  return parts && isSessionId(parts[1]) && isToken(parts[2]) ? { id: parts[1], token: parts[2] } : null
}

export function invitationUrl(session: RelaySession): string {
  return `${location.origin}${location.pathname}#receive/${session.id}/${session.receiverToken}`
}

export async function createRelaySession(signal: AbortSignal): Promise<RelaySession> {
  const response = await fetch('/api/relay', {
    method: 'POST',
    signal,
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  })
  if (!response.ok) throw new Error(response.status === 429 ? 'RATE_LIMIT' : 'UNAVAILABLE')
  const value = await response.json()
  if (
    !value ||
    !isSessionId(value.id) ||
    !isToken(value.senderToken) ||
    !isToken(value.receiverToken) ||
    !Number.isSafeInteger(value.expiresAt)
  )
    throw new Error('PROTOCOL')
  return value
}

export function relayError(reason: string): string {
  switch (reason) {
    case 'RATE_LIMIT':
      return '연결 요청이 많아요. 1분 후 새 링크를 만들어주세요.'
    case 'AUTH':
    case 'EXPIRED':
      return '연결 링크가 만료됐거나 올바르지 않아요. 새 링크를 받아주세요.'
    case 'OCCUPIED':
      return '이미 다른 받는 사람이 연결되어 있어요.'
    case 'CANCELLED':
      return '상대가 전달을 취소했어요.'
    case 'TIMEOUT':
      return '시간 안에 수신을 확인하지 못했어요. 새 연결로 다시 시도해주세요.'
    case 'PROTOCOL':
      return '전달 데이터가 올바르지 않아 연결을 닫았어요.'
    default:
      return '연결이 끊겼어요. 두 화면을 열어둔 채 새 링크로 다시 시도해주세요.'
  }
}

export type RelayConnection = {
  approve: (peerId: string, bytes: ArrayBuffer) => void
  receipt: () => void
  close: () => void
}

export function connectRelay(
  invitation: Invitation,
  role: Role,
  onEvent: (event: ServerMessage) => void,
  onBytes?: (bytes: ArrayBuffer) => void,
): RelayConnection {
  const url = new URL(`/api/relay/${invitation.id}`, location.origin)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(url)
  socket.binaryType = 'arraybuffer'
  let ended = false
  let source: ArrayBuffer | undefined
  let incoming: Uint8Array<ArrayBuffer> | undefined
  let offset = 0
  let sentOffset = 0
  let total = 0
  let transferred = false

  const send = (message: ClientMessage) => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('DISCONNECTED')
    socket.send(JSON.stringify(message))
  }
  const fail = (reason: string) => {
    if (ended) return
    ended = true
    source = incoming = undefined
    onEvent({ type: 'error', reason })
    socket.close()
  }
  const next = () => {
    if (!source || offset >= total) return
    sentOffset = Math.min(offset + RELAY.chunkBytes, total)
    socket.send(source.slice(offset, sentOffset))
  }
  socket.addEventListener('open', () => {
    if (ended) {
      socket.close()
      return
    }
    send({ type: 'auth', role, token: invitation.token })
  })
  socket.addEventListener('message', (event) => {
    if (ended) return
    try {
      if (typeof event.data !== 'string') {
        if (
          role !== 'receiver' ||
          !incoming ||
          !(event.data instanceof ArrayBuffer) ||
          event.data.byteLength !== Math.min(RELAY.chunkBytes, total - offset) ||
          transferred
        ) {
          fail('PROTOCOL')
          return
        }
        incoming.set(new Uint8Array(event.data), offset)
        offset += event.data.byteLength
        send({ type: 'chunk-ack', offset })
        return
      }
      const message = parseServerMessage(event.data)
      if (!message) {
        fail('PROTOCOL')
        return
      }
      if (message.type === 'error') {
        fail(message.reason)
        return
      }
      if (message.type === 'approved') {
        if (total || (role === 'sender' && source?.byteLength !== message.total)) {
          fail('PROTOCOL')
          return
        }
        total = message.total
        if (role === 'receiver') incoming = new Uint8Array(total)
        else next()
      }
      if (message.type === 'progress') {
        if (
          message.total !== total ||
          (role === 'sender'
            ? message.offset !== sentOffset || message.offset <= offset
            : message.offset !== offset)
        ) {
          fail('PROTOCOL')
          return
        }
        if (role === 'sender') {
          offset = message.offset
          next()
        }
      }
      if (message.type === 'transferred') {
        if (!total || offset !== total || transferred) {
          fail('PROTOCOL')
          return
        }
        transferred = true
        if (incoming) {
          onBytes?.(incoming.buffer)
          incoming = undefined
        }
        source = undefined
      }
      if (message.type === 'complete') {
        if (!transferred) {
          fail('PROTOCOL')
          return
        }
        ended = true
        socket.close()
      }
      onEvent(message)
    } catch {
      fail('PROTOCOL')
    }
  })
  socket.addEventListener('error', () => fail('DISCONNECTED'))
  socket.addEventListener('close', () => fail('DISCONNECTED'))

  return {
    approve(peerId, bytes) {
      try {
        if (
          role !== 'sender' ||
          source ||
          total ||
          ended ||
          bytes.byteLength < 40 ||
          bytes.byteLength > RELAY.maxBytes
        )
          throw new Error('PROTOCOL')
        source = bytes
        send({ type: 'approve', peerId, total: bytes.byteLength })
      } catch {
        fail('DISCONNECTED')
      }
    },
    receipt() {
      try {
        if (role !== 'receiver' || !transferred || ended) return
        send({ type: 'receipt' })
      } catch {
        fail('DISCONNECTED')
      }
    },
    close() {
      if (ended) return
      ended = true
      source = incoming = undefined
      if (socket.readyState === WebSocket.OPEN) send({ type: 'cancel' })
      socket.close()
    },
  }
}
