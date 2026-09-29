import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pendingProDestination, proDetailPath, proReturnKey, readProDestination, readProRoute, proPath, pendingProRoute, followProLink } from '../src/lib/pro-navigation.ts'

test('Pro detail restoration accepts only an organization and one UUID target, never tokens or external destinations', () => {
  const orgId = crypto.randomUUID(), shareId = crypto.randomUUID(), requestId = crypto.randomUUID()
  for (const destination of [{ orgId, shareId }, { orgId, requestId }]) {
    const path = proDetailPath(destination)
    assert.deepEqual(readProRoute(path.split('?')[0], '?' + path.split('?')[1]), { page: 'requestId' in destination ? 'requests' : 'shares', orgId, id: 'requestId' in destination ? requestId : shareId })
  }
  for (const query of [
    `?org=${orgId}`, `?share=${shareId}`, `?org=invalid&share=${shareId}`, `?org=${orgId}&share=invalid`,
    `?org=${orgId}&share=${shareId}&request=${requestId}`, `?org=${orgId}&share=${shareId}&share=${shareId}`,
    `?org=${orgId}&share=${shareId}&token=secret`, `?org=${orgId}&share=${shareId}&code=secret`,
    `?org=${orgId}&share=${shareId}&next=https://evil.example`, `?org=${orgId}&share=${shareId}&request=`,
  ]) assert.equal(readProDestination(query), null)
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  let search = '', saved = proDetailPath({ orgId, shareId })
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, get: () => ({ search }) })
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: (key: string) => key === proReturnKey ? saved : null } })
    assert.deepEqual(pendingProDestination(), { orgId, shareId })
    search = `?org=${orgId}&request=${requestId}`
    assert.deepEqual(pendingProDestination(), { orgId, requestId })
    search = '?org=invalid&share=invalid'
    assert.equal(pendingProDestination(), null)
    search = ''; saved = 'https://evil.example/pro?org=' + orgId + '&share=' + shareId
    assert.equal(pendingProDestination(), null)
  } finally {
    if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor); else Reflect.deleteProperty(globalThis, 'location')
    if (storageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor); else Reflect.deleteProperty(globalThis, 'sessionStorage')
  }
})

test('Pro routes round trip pages and creation context while rejecting unsafe or ambiguous links', () => {
  const orgId = crypto.randomUUID(), id = crypto.randomUUID(), environmentId = crypto.randomUUID()
  for (const page of ['start', 'requests', 'shares', 'projects', 'team', 'settings', 'beta'] as const) {
    for (const route of [{ page }, { page, orgId }]) {
      const url = new URL(proPath(route), 'https://example.test')
      assert.deepEqual(readProRoute(url.pathname, url.search), route)
    }
  }
  for (const route of [{ page: 'projects' as const, orgId, id }, { page: 'requests' as const, orgId, environmentId, create: true }, { page: 'shares' as const, orgId, id }]) {
    const url = new URL(proPath(route), 'https://example.test')
    assert.deepEqual(readProRoute(url.pathname, url.search), route)
  }
  assert.deepEqual(readProRoute('/pro', `?org=${orgId}&share=${id}`), { page: 'shares', orgId, id })
  for (const path of ['/proevil', '//evil.test/pro', '/pro/unknown', '/pro/shares/invalid', `/pro/team/${id}?org=${orgId}`, `/pro/requests/${id}`, `/pro/shares/${id}?org=${orgId}&create=1`, `/pro/projects?org=${orgId}&create=1`, `/pro/requests?environment=${environmentId}`, '/pro?org=', '/pro?create=0', `/pro/shares?org=${orgId}&org=${orgId}`, '/pro/settings?next=https://evil.test', '/pro/shares?token=secret', '/pro/shares?code=secret']) {
    const query = path.indexOf('?')
    assert.equal(readProRoute(query < 0 ? path : path.slice(0, query), query < 0 ? '' : path.slice(query)), null, path)
  }
})

test('OAuth return keeps only a validated Pro route; explicit current routes win and modified clicks stay native', () => {
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location'), storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
  const orgId = crypto.randomUUID(), id = crypto.randomUUID()
  let saved = `/pro/shares/${id}?org=${orgId}`, pathname = '/pro', search = '', hash = ''
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, get: () => ({ pathname, search, href: 'https://example.test' + pathname + search + hash, origin: 'https://example.test' }) })
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => saved } })
    assert.deepEqual(pendingProRoute(), { page: 'shares', orgId, id })
    hash = '#invite=' + 'a'.repeat(43); assert.deepEqual(pendingProRoute(), { page: 'start' })
    hash = ''; assert.deepEqual(pendingProRoute(), { page: 'shares', orgId, id })
    pathname = '/pro/settings'; assert.deepEqual(pendingProRoute(), { page: 'settings' })
    pathname = '/pro'; search = '?org=bad'; assert.equal(pendingProRoute(), null)
    search = ''; saved = 'https://evil.test/pro'; assert.deepEqual(pendingProRoute(), { page: 'start' })
    saved = '/pro/shares?token=secret'; assert.deepEqual(pendingProRoute(), { page: 'start' })
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get: () => { throw new Error('Storage blocked') } })
    assert.deepEqual(pendingProRoute(), { page: 'start' })
  } finally {
    if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor); else Reflect.deleteProperty(globalThis, 'location')
    if (storageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor); else Reflect.deleteProperty(globalThis, 'sessionStorage')
  }
  let followed = 0, prevented = 0
  const event = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: () => { prevented++ } }
  for (const modified of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) followProLink({ ...event, ...modified }, { page: 'start' }, () => { followed++ })
  assert.equal(followed, 0); assert.equal(prevented, 0)
  followProLink(event, { page: 'start' }, () => { followed++ })
  assert.equal(followed, 1); assert.equal(prevented, 1)
})
