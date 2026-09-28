export function invitationToken(value: string, origin: string): string | null {
  const input = value.trim()
  if (/^[A-Za-z0-9_-]{43}$/.test(input)) return input
  try {
    const url = new URL(input)
    const params = new URLSearchParams(url.hash.slice(1))
    const token = params.get('invite') ?? ''
    return url.origin === origin && url.pathname === '/pro' && params.getAll('invite').length === 1 && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null
  } catch { return null }
}

export function pendingInvitation(): string {
  const token = invitationToken(location.href, location.origin)
  try {
    if (token) sessionStorage.setItem('envhandoff-invitation', token)
    return token ?? sessionStorage.getItem('envhandoff-invitation') ?? ''
  } catch { return token ?? '' }
}
