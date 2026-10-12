// Mocked HTTP with the actual login/workspace tree and browser device keys.
import { createRoot } from 'react-dom/client'
import { ProLogin } from '../src/components/ProLogin.tsx'
import { ProRequests } from '../src/components/ProRequests.tsx'
import { createLocalDevice, deleteLocalDevice } from '../src/lib/device-keys.ts'
import type { ProRoute } from '../src/lib/pro-navigation.ts'

const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000
  do {
    await new Promise(resolve => setTimeout(resolve, 20))
    if (condition()) return
  } while (Date.now() < deadline)
  throw new Error('Request flow regression timed out')
}

export async function verifyRequestWorkQueue() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch
  const orgId = crypto.randomUUID(), userId = crypto.randomUUID(), api = '/__request-flow-qa'
  const base = { createdAt: 1, expiresAt: Date.now() + 86400000, project: 'QA', sender: 'sender', receiver: 'receiver' }
  const transfer = { id: crypto.randomUUID(), status: 'available', expiresAt: Date.now() + 86400000, acknowledgedAt: null }
  const items = [
    { ...base, id: crypto.randomUUID(), status: 'pending', direction: 'incoming', environment: 'approve' },
    { ...base, id: crypto.randomUUID(), status: 'approved', direction: 'incoming', environment: 'send' },
    { ...base, id: crypto.randomUUID(), status: 'fulfilled', direction: 'outgoing', environment: 'receive', transfer },
    { ...base, id: crypto.randomUUID(), status: 'pending', direction: 'outgoing', environment: 'waiting' },
    { ...base, id: crypto.randomUUID(), status: 'fulfilled', direction: 'managed', environment: 'monitor', transfer },
    { ...base, id: crypto.randomUUID(), status: 'cancelled', direction: 'outgoing', environment: 'ended' },
    { ...base, id: crypto.randomUUID(), status: 'fulfilled', direction: 'outgoing', environment: 'received', transfer: { ...transfer, acknowledgedAt: 1 } },
  ]
  let route: ProRoute = { page: 'requests', orgId }
  const render = () => root.render(<ProRequests api={api} orgId={orgId} userId={userId} csrf="test-only" route={route} disabled={false} onExpired={() => { throw new Error('Unexpected expiry') }} onNavigate={next => { route = next; render() }} />)
  window.fetch = async (input, init) => {
    const path = String(input)
    if (!path.startsWith(api)) return originalFetch(input, init)
    check(!init?.method || init.method === 'GET', 'Opening tasks must not write')
    return Response.json(route.id ? items.find(item => item.id === route.id) : { requests: items })
  }
  try {
    render(); await until(() => host.querySelectorAll('article').length === items.length && !host.querySelector('[aria-busy="true"]'))
    check(host.querySelector('[aria-label="내가 처리할 일"]')?.querySelectorAll('article').length === 3, 'Approval, upload and available receive belong to my tasks')
    check(host.querySelector('[aria-label="상대 대기"]')?.querySelectorAll('article').length === 2, 'Requester wait and Owner monitor belong to waiting')
    check(host.querySelector('[aria-label="종료"]')?.querySelectorAll('article').length === 2, 'Cancelled and acknowledged requests belong to history')
    const monitor = [...host.querySelectorAll('article')].find(item => item.textContent?.includes('monitor'))!
    check(!monitor.textContent?.includes('파일 받기') && monitor.textContent?.includes('진행 상태 확인'), 'Owner monitor must never have a file receive CTA')
    monitor.querySelector<HTMLAnchorElement>('.button')!.click()
    await until(() => !!host.querySelector('.pro-detail') && !host.querySelector('[aria-busy="true"]'))
    check(!host.querySelector('.pro-transfer'), 'Owner monitor detail cannot mount a transfer receiver')
    check(host.querySelector('.copy-field')?.closest('details') === null, 'Waiting task link must be immediately available')
    route = { page: 'requests', orgId, id: items[5]!.id }; render()
    await until(() => host.textContent?.includes('이 요청으로는 더 받을 수 없어요.') === true && !host.querySelector('[aria-busy="true"]'))
    check([...host.querySelectorAll('a')].some(node => node.textContent === '새 파일 요청'), 'Ended requester gets a fresh request action')
    return { passed: true, checks: ['task groups by next actor', 'contextual CTAs', 'Owner metadata-only detail', 'waiting link discovery', 'ended request next action'] }
  } finally { root.unmount(); window.fetch = originalFetch; host.remove() }
}

export async function verifyRequestPreparationAndScope() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch, previousUrl = location.href, previousHistory = history.state
  const firstOrg = crypto.randomUUID(), secondOrg = crypto.randomUUID(), userId = crypto.randomUUID(), otherUser = crypto.randomUUID()
  const environments = [crypto.randomUUID(), crypto.randomUUID()], senders = [crypto.randomUUID(), crypto.randomUUID()], requestId = crypto.randomUUID()
  const device = await createLocalDevice(userId, crypto.randomUUID())
  const organizations = [{ id: firstOrg, name: '첫 팀', role: 'member', active: 1 }, { id: secondOrg, name: '둘째 팀', role: 'member', active: 1 }]
  let currentUser = userId, csrf = 'test-only', deviceStatus = 'pending', writes = 0, signedIn = true
  let submitted: Record<string, unknown> | null = null
  const ready = () => !host.querySelector('[aria-busy="true"]')
  const click = (text: string) => { const element = [...host.querySelectorAll<HTMLAnchorElement | HTMLButtonElement>('a,button')].find(node => node.textContent === text); check(element, 'Missing action: ' + text); element!.click() }
  const select = (id: string, value: string) => { const element = host.querySelector<HTMLSelectElement>('#' + id)!; element.value = value; element.dispatchEvent(new Event('change', { bubbles: true })) }
  window.fetch = async (input, init) => {
    const path = new URL(String(input), location.href).pathname
    if (path === '/auth/session') return signedIn ? Response.json({ user: { id: currentUser, login: 'qa-member' }, csrf, expiresAt: Date.now() + 3600000 }) : new Response(null, { status: 401 })
    if (path === '/auth/logout') { signedIn = false; return Response.json({}) }
    if (path === '/organizations') return Response.json(organizations)
    if (organizations.some(org => path === '/organizations/' + org.id)) return Response.json({ ...organizations.find(org => path.endsWith(org.id)), teams: [], members: [], invitations: [] })
    if (path === '/beta') return Response.json({ active: false, operator: false, owned: 0, workspaceLimit: 2 })
    if (path === '/security') return Response.json({ passkeys: [{ id: 'factor', label: 'QA 패스키' }], totp: false, totpAvailable: false, canRegisterDevice: true, reauthenticatedUntil: 0, devices: currentUser === userId ? [{ identity: { deviceId: device.deviceId }, status: deviceStatus }] : [] })
    if (path.endsWith('/catalog')) return Response.json({ role: 'member', teams: [], projects: [{ name: 'QA', environments: environments.map((id, i) => ({ id, name: i ? 'production' : 'development', permissions: { receive: true } })) }] })
    if (path.endsWith('/requests/options')) return Response.json({ senders: senders.map((id, i) => ({ id, login: i ? 'chosen-sender' : 'first-sender' })) })
    const request = { id: requestId, status: 'pending', direction: 'outgoing', createdAt: 1, expiresAt: Date.now() + 86400000, project: 'QA', environment: 'production', sender: 'chosen-sender', receiver: 'qa-member' }
    if (path.endsWith('/requests') && init?.method === 'POST') { writes++; submitted = JSON.parse(init.body as string); check(new Headers(init.headers).get('x-csrf-token') === csrf, 'Request creation must retain CSRF'); return Response.json(request) }
    if (path.endsWith('/requests/' + requestId)) return Response.json(request)
    throw new Error('Unexpected request flow API: ' + path)
  }
  const begin = async () => {
    history.pushState(null, '', `/pro/requests?org=${firstOrg}&create=1`)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await until(() => host.querySelector<HTMLSelectElement>('#request-sender')?.disabled === false && ready())
    select('request-environment', environments[1]!); await until(() => host.querySelector<HTMLSelectElement>('#request-sender')?.disabled === false && ready())
    select('request-sender', senders[1]!); await until(() => host.querySelector<HTMLSelectElement>('#request-sender')?.value === senders[1])
  }
  try {
    history.replaceState(null, '', `/pro/requests?org=${firstOrg}&create=1`)
    root.render(<ProLogin />)
    await until(() => host.querySelector<HTMLSelectElement>('#request-sender')?.disabled === false && ready())
    check(host.querySelector<HTMLSelectElement>('#request-sender')!.value === '', 'Sender must be chosen explicitly')
    select('request-environment', environments[1]!); await until(() => host.querySelector<HTMLSelectElement>('#request-sender')?.disabled === false)
    select('request-sender', senders[1]!); await until(() => host.querySelector<HTMLSelectElement>('#request-sender')?.value === senders[1])
    check(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, 'Pending device must block creation before submit')
    click('기기 승인 안내 보기'); await until(() => host.textContent?.includes('요청 작성으로 돌아가기') === true && ready())
    check(!location.href.includes(senders[1]!) && !sessionStorage.getItem('envhandoff-request-draft'), 'Request selection must stay in memory')
    deviceStatus = 'active'; click('요청 작성으로 돌아가기')
    await until(() => host.querySelector<HTMLSelectElement>('#request-sender')?.value === senders[1] && ready())
    check(host.querySelector<HTMLSelectElement>('#request-environment')!.value === environments[1], 'Device preparation must retain the chosen environment')
    check(!host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, 'Active browser device unlocks the retained request')
    click('파일 요청'); await until(() => writes === 1 && !!host.querySelector('.pro-detail') && ready())
    check(submitted?.environmentId === environments[1] && submitted?.senderId === senders[1] && submitted?.deviceId === device.deviceId, 'Creation must use the retained selection and registered browser')

    deviceStatus = 'pending'; await begin(); click('기기 승인 안내 보기'); await until(() => host.textContent?.includes('요청 작성으로 돌아가기') === true && ready())
    host.querySelector<HTMLElement>('.pro-switcher summary')!.click()
    ;[...host.querySelectorAll<HTMLAnchorElement>('.pro-switcher-options > a')].find(node => node.textContent?.includes('둘째 팀'))!.click()
    await until(() => location.search.includes(secondOrg) && ready())
    check(!host.textContent?.includes('요청 작성으로 돌아가기'), 'Switching workspace must clear the draft')
    await begin(); click('기기 승인 안내 보기'); await until(() => host.textContent?.includes('요청 작성으로 돌아가기') === true && ready())
    csrf = 'new-session'; window.dispatchEvent(new Event('focus')); await until(() => !host.textContent?.includes('요청 작성으로 돌아가기') && ready())
    await begin(); click('기기 승인 안내 보기'); await until(() => host.textContent?.includes('요청 작성으로 돌아가기') === true && ready())
    currentUser = otherUser; window.dispatchEvent(new Event('focus')); await until(() => !host.textContent?.includes('요청 작성으로 돌아가기') && ready())
    click('로그아웃'); await until(() => !!host.querySelector('.pro-entry') && ready())
    check(!host.textContent?.includes('요청 작성으로 돌아가기'), 'Logout must remove all draft UI')
    return { passed: true, checks: ['explicit sender choice', 'pending browser blocked before submission', 'settings roundtrip preserves selection', 'active device and CSRF submission', 'workspace switch clears draft', 'session change clears draft', 'account switch and logout clear draft'] }
  } finally { root.unmount(); window.fetch = originalFetch; history.replaceState(previousHistory, '', previousUrl); host.remove(); await deleteLocalDevice(userId); await deleteLocalDevice(otherUser) }
}
