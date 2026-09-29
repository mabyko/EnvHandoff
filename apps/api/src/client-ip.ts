import { isIP } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

export function clientIpPolicy(originSecret = '') {
  if (originSecret && !/^[a-f0-9]{64}$/.test(originSecret)) throw new Error('CLOUDFLARE_ORIGIN_SECRET must be a random 32-byte lowercase hex value')
  return (remote: string | undefined, headers: IncomingHttpHeaders, method: string | undefined, path: string): string | null => {
    if (!remote || !isIP(remote)) return null
    if (!originSecret) return remote // Direct self-hosting never trusts caller-supplied forwarding headers.
    // Container-local health probe only; authenticated/API requests cannot use this exception.
    if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && method === 'GET' && path === '/auth/session'
      && !headers.cookie && !headers.authorization && !headers.origin && !headers['x-real-ip'] && !headers['cf-connecting-ip']) return remote
    // Our zone overwrites this header before forwarding over strict HTTPS. Other zones cannot mint it.
    const proof = headers['x-envhandoff-origin'], client = headers['cf-connecting-ip']
    if (typeof proof !== 'string' || !/^[a-f0-9]{64}$/.test(proof)
      || !timingSafeEqual(Buffer.from(proof), Buffer.from(originSecret))) return null
    if (typeof client !== 'string' || !isIP(client)) return null
    return isIP(client) === 6 ? new URL(`http://[${client}]`).hostname.slice(1, -1) : client
  }
}
