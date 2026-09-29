export type ProDestination = { orgId: string; requestId?: string; shareId?: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const proReturnKey = 'envhandoff-pro-return'

export function readProDestination(search: string): ProDestination | null {
  const params = new URLSearchParams(search)
  if ([...params.keys()].some(key => !['org', 'request', 'share', 'auth'].includes(key))) return null
  const orgId = params.get('org') ?? '', requestId = params.get('request'), shareId = params.get('share')
  if (!uuid.test(orgId) || params.getAll('org').length !== 1 || (!!requestId === !!shareId)) return null
  if (requestId && (params.getAll('request').length !== 1 || !uuid.test(requestId))) return null
  if (shareId && (params.getAll('share').length !== 1 || !uuid.test(shareId))) return null
  if (params.has('request') && !requestId || params.has('share') && !shareId) return null
  return { orgId, ...(requestId ? { requestId } : { shareId: shareId! }) }
}

export function proDetailPath(destination: ProDestination): string {
  return proPath({ page: destination.requestId ? 'requests' : 'shares', orgId: destination.orgId, id: destination.requestId ?? destination.shareId })
}

export function pendingProDestination(): ProDestination | null {
  if (location.search && ['org', 'request', 'share'].some(key => new URLSearchParams(location.search).has(key))) return readProDestination(location.search)
  try {
    const path = sessionStorage.getItem(proReturnKey)
    if (!path) return null
    const query = path.indexOf('?')
    const route = readProRoute(query < 0 ? path : path.slice(0, query), query < 0 ? '' : path.slice(query))
    return route?.orgId && route.id && (route.page === 'requests' || route.page === 'shares') ? { orgId: route.orgId, ...(route.page === 'requests' ? { requestId: route.id } : { shareId: route.id }) } : null
  } catch { return null }
}

export type ProRoute = { page: 'start' | 'requests' | 'shares' | 'projects' | 'team' | 'settings' | 'beta'; orgId?: string; id?: string; environmentId?: string; create?: boolean }
const pages = ['requests', 'shares', 'projects', 'team', 'settings', 'beta'] as const

export function readProRoute(pathname: string, search = ''): ProRoute | null {
  const params = new URLSearchParams(search)
  if (pathname === '/pro' || pathname === '/pro/') {
    if (params.has('request') || params.has('share')) {
      const legacy = readProDestination(search)
      return legacy ? { page: legacy.requestId ? 'requests' : 'shares', orgId: legacy.orgId, id: legacy.requestId ?? legacy.shareId } : null
    }
  }
  const match = /^\/pro(?:\/(requests|shares|projects|team|settings|beta)(?:\/([^/]+))?)?\/?$/.exec(pathname)
  if (!match || [...params.keys()].some(key => !['org', 'environment', 'create', 'auth'].includes(key))) return null
  for (const key of ['org', 'environment', 'create', 'auth']) if (params.getAll(key).length > 1) return null
  const page = (match[1] ?? 'start') as ProRoute['page'], id = match[2], orgId = params.get('org'), environmentId = params.get('environment')
  if (orgId !== null && !uuid.test(orgId) || environmentId !== null && !uuid.test(environmentId)) return null
  if (id && (!uuid.test(id) || !orgId || !['requests', 'shares', 'projects'].includes(page))) return null
  if (params.has('create') && (params.get('create') !== '1' || id || !['requests', 'shares'].includes(page))) return null
  if (environmentId && (!orgId || params.get('create') !== '1')) return null
  return { page, ...(orgId ? { orgId } : {}), ...(id ? { id } : {}), ...(environmentId ? { environmentId } : {}), ...(params.has('create') ? { create: true } : {}) }
}

export function proPath(route: ProRoute): string {
  if (route.page !== 'start' && !pages.includes(route.page)) throw new Error('Invalid Pro page')
  const pathname = '/pro' + (route.page === 'start' ? '' : '/' + route.page) + (route.id ? '/' + route.id : '')
  const params = new URLSearchParams()
  if (route.orgId) params.set('org', route.orgId)
  if (route.environmentId) params.set('environment', route.environmentId)
  if (route.create) params.set('create', '1')
  const search = params.size ? '?' + params.toString() : ''
  if (!readProRoute(pathname, search)) throw new Error('Invalid Pro route')
  return pathname + search
}

export function pendingProRoute(): ProRoute | null {
  const current = readProRoute(location.pathname, location.search)
  if (!current || location.pathname.replace(/\/$/, '') !== '/pro' || new URLSearchParams(location.search).has('org')) return current
  try {
    const saved = sessionStorage.getItem(proReturnKey)
    if (saved?.startsWith('/pro')) {
      const query = saved.indexOf('?')
      const restored = readProRoute(query < 0 ? saved : saved.slice(0, query), query < 0 ? '' : saved.slice(query))
      if (restored) return restored
    }
  } catch { /* The original link can be opened again when storage is blocked. */ }
  return current
}

export function followProLink(event: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }, route: ProRoute, navigate: (route: ProRoute) => void) {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  event.preventDefault()
  navigate(route)
}
