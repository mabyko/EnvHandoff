import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export function totp(secret: Uint8Array, counter: number): string {
  const input = Buffer.alloc(8)
  input.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', secret).update(input).digest()
  const offset = digest[digest.length - 1]! & 15
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0')
}

export function totpCounter(secret: Uint8Array, code: unknown, now: number, previous: number): number | undefined {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return undefined
  const current = Math.floor(now / 30_000)
  // One step of clock drift in either direction; a used step never authenticates again.
  for (const counter of [current, current - 1, current + 1]) {
    if (counter > previous && counter >= 0 && timingSafeEqual(Buffer.from(totp(secret, counter)), Buffer.from(code))) return counter
  }
  return undefined
}

export function base32(secret: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let result = '', bits = 0, value = 0
  for (const byte of secret) {
    value = (value << 8) | byte; bits += 8
    while (bits >= 5) { bits -= 5; result += alphabet[(value >>> bits) & 31] }
  }
  if (bits) result += alphabet[(value << (5 - bits)) & 31]
  return result
}

// The server key is separate from the DB and OAuth credentials. AAD prevents account swaps.
export function sealTotp(secret: Uint8Array, key: Buffer, userId: string): string {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(Buffer.from('EnvHandoff TOTP v1:' + userId))
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url')
}

export function openTotp(value: string, key: Buffer, userId: string): Buffer {
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== 48) throw new Error('Invalid encrypted TOTP secret')
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  cipher.setAAD(Buffer.from('EnvHandoff TOTP v1:' + userId)); cipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()])
}
