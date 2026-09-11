export const RELAY = {
  maxBytes: 16 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  lifetimeMs: 10 * 60 * 1000,
  idleMs: 30 * 1000,
  receiptMs: 2 * 60 * 1000,
  authMs: 5 * 1000,
} as const

export type Role = 'sender' | 'receiver'
export type Invitation = { id: string; token: string }
export type RelaySession = { id: string; senderToken: string; receiverToken: string; expiresAt: number }
export type ClientMessage =
  | { type: 'auth'; role: Role; token: string }
  | { type: 'approve'; peerId: string; total: number }
  | { type: 'chunk-ack'; offset: number }
  | { type: 'receipt' }
  | { type: 'cancel' }

export type ServerMessage =
  | { type: 'ready'; role: Role; expiresAt: number }
  | { type: 'peer'; peerId: string; verification: string }
  | { type: 'approved'; total: number }
  | { type: 'progress'; offset: number; total: number }
  | { type: 'transferred' }
  | { type: 'complete' }
  | { type: 'error'; reason: string }

export const isToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
export const isSessionId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

export function parseClientMessage(input: string): ClientMessage | null {
  if (input.length > 1024) return null
  try {
    const value = JSON.parse(input)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const keys = Object.keys(value).sort().join(',')
    if (
      value.type === 'auth' &&
      keys === 'role,token,type' &&
      (value.role === 'sender' || value.role === 'receiver') &&
      isToken(value.token)
    )
      return value
    if (
      value.type === 'approve' &&
      keys === 'peerId,total,type' &&
      typeof value.peerId === 'string' &&
      /^[0-9a-f-]{36}$/.test(value.peerId) &&
      Number.isSafeInteger(value.total) &&
      value.total >= 40 &&
      value.total <= RELAY.maxBytes
    )
      return value
    if (
      value.type === 'chunk-ack' &&
      keys === 'offset,type' &&
      Number.isSafeInteger(value.offset) &&
      value.offset > 0 &&
      value.offset <= RELAY.maxBytes
    )
      return value
    if ((value.type === 'receipt' || value.type === 'cancel') && keys === 'type') return value
  } catch {
    /* Reject untrusted messages without logging their contents. */
  }
  return null
}

export function parseServerMessage(input: string): ServerMessage | null {
  if (input.length > 1024) return null
  try {
    const value = JSON.parse(input)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    switch (value.type) {
      case 'ready':
        return (value.role === 'sender' || value.role === 'receiver') && Number.isSafeInteger(value.expiresAt)
          ? value
          : null
      case 'peer':
        return typeof value.peerId === 'string' &&
          /^[0-9a-f-]{36}$/.test(value.peerId) &&
          typeof value.verification === 'string' &&
          /^\d{6}$/.test(value.verification)
          ? value
          : null
      case 'approved':
        return Number.isSafeInteger(value.total) && value.total >= 40 && value.total <= RELAY.maxBytes
          ? value
          : null
      case 'progress':
        return Number.isSafeInteger(value.offset) &&
          Number.isSafeInteger(value.total) &&
          value.offset > 0 &&
          value.offset <= value.total &&
          value.total <= RELAY.maxBytes
          ? value
          : null
      case 'transferred':
      case 'complete':
        return value
      case 'error':
        return typeof value.reason === 'string' && value.reason.length <= 80 ? value : null
      default:
        return null
    }
  } catch {
    return null
  }
}
