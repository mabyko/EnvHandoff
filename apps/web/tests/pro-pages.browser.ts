// Run only in an isolated QA browser on the Vite dev origin:
// await (await import('/tests/pro-pages.browser.ts')).verifyProPages()
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ProRequests } from '../src/components/ProRequests.tsx'
import { ProShares } from '../src/components/ProShares.tsx'
import type { ProRoute } from '../src/lib/pro-navigation.ts'

const orgId = '10000000-0000-4000-8000-000000000001', userId = '20000000-0000-4000-8000-000000000001'
const firstId = '30000000-0000-4000-8000-000000000001', secondId = '30000000-0000-4000-8000-000000000002'
const environmentId = '40000000-0000-4000-8000-000000000002'
const api = '/__pro-page-regression'
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
async function until(condition: () => boolean) {
  const end = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > end) throw new Error('Pro page check timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

export async function verifyProPages() {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), originalFetch = window.fetch, originalUpload = window.XMLHttpRequest
  const request = (id: string) => ({ id, status: 'pending', direction: 'outgoing', createdAt: 1, expiresAt: Date.now() + 86400000, project: 'QA project', environment: id === firstId ? 'First environment' : 'Second environment', sender: 'sender', receiver: 'receiver' })
  const share = (id: string, status = 'available') => ({ id, status, createdAt: 1, expiresAt: Date.now() + 86400000, acknowledgedAt: null, project: 'QA project', environment: 'Share environment', canReissue: true, canRevoke: true })
  const shares = new Map([[firstId, share(firstId)], [secondId, share(secondId)]])
  const catalog = { projects: [{ name: 'QA project', environments: [firstId, environmentId].map((id, index) => ({ id, name: 'Environment ' + index, permissions: { receive: true, externalShare: true } })) }] }
  let route: ProRoute = { page: 'requests', orgId }, createdId = ''
  function render() {
    const props = { api, orgId, userId, csrf: 'test-only', disabled: false, route, onNavigate: (next: ProRoute) => { route = next; render() }, onExpired: () => { throw new Error('Unexpected session expiry') } }
    root.render(route.page === 'requests' ? createElement(ProRequests, props) : createElement(ProShares, props))
  }
  const ready = () => !!container.querySelector('h2') && !container.querySelector('[aria-busy="true"]')
  const click = (text: string) => {
    const node = [...container.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>('button,a')].find(item => item.textContent === text)
    check(node, 'Missing action: ' + text); node!.click()
  }
  const field = (text: string) => {
    const label = [...container.querySelectorAll<HTMLLabelElement>('label')].find(item => item.textContent === text)
    return label ? container.querySelector<HTMLInputElement>('#' + CSS.escape(label.htmlFor)) : null
  }
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.startsWith(api)) return originalFetch(input, init)
    const path = url.slice(api.length), method = init?.method ?? 'GET'
    if (path.endsWith('/catalog')) return Response.json(catalog)
    if (path.includes('/requests/options?')) return Response.json({ senders: [{ id: userId, login: 'sender' }] })
    if (path.endsWith('/requests')) return Response.json({ requests: [request(firstId), request(secondId)] })
    if (path.includes('/requests/')) return Response.json(request(path.split('/').at(-1)!))
    if (path.endsWith('/shares') && method === 'POST') {
      const body = JSON.parse(init?.body as string); createdId = body.operationId
      shares.set(createdId, share(createdId, 'reserved')); return Response.json(shares.get(createdId))
    }
    if (path.endsWith('/shares')) return Response.json({ shares: [...shares.values()] })
    const id = path.split('/')[4]
    if (!shares.has(id)) return Response.json({ error: 'share_unavailable' }, { status: 404 })
    if (path.endsWith('/content')) shares.set(id, share(id))
    return Response.json(shares.get(id))
  }
  class MockUpload {
    upload = { onprogress: (_event: { lengthComputable: boolean; loaded: number; total: number }) => {} }
    status = 200; responseText = ''; withCredentials = false; timeout = 0
    onload = () => {}; onloadend = () => {}; onabort = () => {}; onerror = () => {}; ontimeout = () => {}
    open() {} setRequestHeader() {} getResponseHeader() { return null }
    send(bytes: ArrayBuffer) { queueMicrotask(() => { shares.set(createdId, share(createdId)); this.upload.onprogress({lengthComputable:true,loaded:bytes.byteLength,total:bytes.byteLength}); this.onload(); this.onloadend() }) }
    abort() { this.onabort(); this.onloadend() }
  }
  window.XMLHttpRequest = MockUpload as unknown as typeof XMLHttpRequest
  try {
    render()
    await until(() => ready() && container.querySelectorAll('.pro-list article').length === 2)
    check(!container.querySelector('form'), 'Request list must not show the creation form')
    check(!container.querySelector('[aria-label="파일 전달"]'), 'Request list must not mount transfer editors')
    click('요청 열기')
    await until(() => ready() && route.id === firstId && !!container.querySelector('.pro-detail'))
    check(container.querySelectorAll('article').length === 1 && !container.textContent!.includes('Second environment'), 'Request detail must show only its target')
    route = { page: 'requests', orgId, create: true, environmentId }; render()
    await until(() => ready() && container.querySelector<HTMLSelectElement>('#request-environment')?.value === environmentId && !!container.querySelector('#request-sender option'))
    check(!container.querySelector('article'), 'Request create must not render the request list')
    route = { page: 'shares', orgId }; render()
    await until(() => ready() && container.querySelectorAll('.pro-list article').length === 2)
    check(!container.querySelector('input[type="file"]'), 'Share list must not show the upload form')
    route = { page: 'shares', orgId, create: true, environmentId }; render()
    await until(() => ready() && !!container.querySelector('input[type="file"]'))
    check(container.querySelector<HTMLSelectElement>('select')?.value === environmentId, 'Project-selected share environment must be retained')
    const files = new DataTransfer(); files.items.add(new File(['DEMO=1\r\n'], '.env'))
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!; input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => [...container.querySelectorAll<HTMLButtonElement>('button')].some(button => button.textContent === '암호화해서 외부 공유' && !button.disabled))
    click('암호화해서 외부 공유')
    await until(() => ready() && route.id === createdId && !!field('다른 경로로 전달할 공유 코드'))
    const code = field('다른 경로로 전달할 공유 코드')!.value
    check(code.length === 43 && container.querySelectorAll('article').length === 1, 'Creation must navigate to only the new detail without losing its code')
    click('공유 목록')
    await until(() => ready() && !!container.querySelector('.pro-list'))
    check(!field('다른 경로로 전달할 공유 코드'), 'Secrets must not appear in the summary list')
    route = { page: 'shares', orgId, id: createdId }; render()
    await until(() => ready() && !!field('다른 경로로 전달할 공유 코드'))
    check(field('다른 경로로 전달할 공유 코드')!.value === code, 'Same-component list/detail navigation must retain the original code')
    route = { page: 'shares', orgId, id: '30000000-0000-4000-8000-000000000099' }; render()
    await until(() => ready() && !!container.querySelector('[role="alert"]'))
    check(!container.querySelector('article') && !field('다른 경로로 전달할 공유 코드'), 'Unavailable detail must not expose another share')
    return { passed: true, checks: ['request list/detail/create', 'project environment selection', 'share list/detail/create', 'code retained after creation and navigation', 'unavailable detail isolation'] }
  } finally { root.unmount(); window.fetch = originalFetch; window.XMLHttpRequest = originalUpload; container.remove() }
}
