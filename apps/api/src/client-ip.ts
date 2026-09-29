import { BlockList, isIP } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'

// Cloudflare's published origin-facing ranges: https://www.cloudflare.com/ips/
// Recheck these on infrastructure changes; new ranges fail closed until updated.
const cloudflare = new BlockList()
for (const cidr of [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
]) {
  const [ip, prefix] = cidr.split('/')
  cloudflare.addSubnet(ip!, Number(prefix), isIP(ip!) === 6 ? 'ipv6' : 'ipv4')
}

export function clientIpPolicy(proxyIp = '') {
  const proxy = new BlockList()
  if (proxyIp) {
    if (!isIP(proxyIp)) throw new Error('CLOUDFLARE_PROXY_IP must be the exact address of the local reverse proxy')
    proxy.addAddress(proxyIp, isIP(proxyIp) === 6 ? 'ipv6' : 'ipv4')
  }
  return (remote: string | undefined, headers: IncomingHttpHeaders, method: string | undefined, path: string): string | null => {
    if (!remote || !isIP(remote)) return null
    if (!proxyIp) return remote // Direct self-hosting never trusts caller-supplied forwarding headers.
    // Container-local health probe only; authenticated/API requests cannot use this exception.
    if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && method === 'GET' && path === '/auth/session'
      && !headers.cookie && !headers.authorization && !headers.origin && !headers['x-real-ip'] && !headers['cf-connecting-ip']) return remote
    if (!proxy.check(remote, isIP(remote) === 6 ? 'ipv6' : 'ipv4')) return null
    // The local proxy MUST overwrite X-Real-IP with its TCP peer, never an incoming header.
    const edge = headers['x-real-ip'], client = headers['cf-connecting-ip']
    if (typeof edge !== 'string' || !isIP(edge) || !cloudflare.check(edge, isIP(edge) === 6 ? 'ipv6' : 'ipv4')) return null
    if (typeof client !== 'string' || !isIP(client)) return null
    return isIP(client) === 6 ? new URL(`http://[${client}]`).hostname.slice(1, -1) : client
  }
}
