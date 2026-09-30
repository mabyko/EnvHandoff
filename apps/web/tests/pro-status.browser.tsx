// Isolated Vite/Chrome QA: (await import('/tests/pro-status.browser.tsx')).verifyProStatusLayout()
// Login QA: (await import('/tests/pro-status.browser.tsx')).verifyProLoginPending()
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ProLogin } from '../src/components/ProLogin.tsx'

async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Status UI timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }

export async function mountProStatusQA(signedIn = true) {
  const previous = { fetch: window.fetch, url: location.href, history: history.state }
  history.replaceState(null, '', signedIn ? '/pro/beta?org=00000000-0000-4000-8000-000000000001' : '/pro')
  document.querySelector<HTMLElement>('#root')!.hidden = true
  const host = document.createElement('div'); host.className = 'page-wrap pro-page'; document.body.append(host)
  const root = createRoot(host)
  const state = { paused: true, hold: false, starts: 0, sessions: 0, loginResponse: 'failed' as 'failed' | 'invalid' }
  const organization = { id: '00000000-0000-4000-8000-000000000001', name: '테스트 워크스페이스', role: 'owner', active: 1 }
  window.fetch = async input => {
    const path = new URL(String(input), location.href).pathname
    if (path === '/auth/session') state.sessions++
    if (path === '/auth/github/start') state.starts++
    await until(() => !state.hold)
    if (path === '/auth/session') return signedIn ? Response.json({ user: { id: 'qa', login: 'qa-user' }, csrf: 'qa', expiresAt: Date.now() + 3600_000, acceptNewTransfers: !state.paused }) : new Response(null, { status: 401 })
    if (path === '/auth/github/start') return state.loginResponse === 'failed' ? new Response(null, { status: 503 }) : Response.json({ url: 'https://example.com/login/oauth/authorize' })
    if (path === '/organizations') return Response.json([organization])
    if (path === '/organizations/00000000-0000-4000-8000-000000000001') return Response.json({ ...organization, teams: [], members: [], invitations: [] })
    if (path === '/beta') return Response.json({ active: true, operator: false, owned: 1, workspaceLimit: 2 })
    throw new Error('Unexpected QA request: ' + path)
  }
  root.render(createElement(ProLogin))
  await until(() => !!host.querySelector(signedIn ? '.pro-welcome-card' : '.pro-entry .button') && !host.querySelector('[aria-busy="true"]'))
  return { host, state, cleanup: () => {
    state.hold = false; root.unmount(); host.remove(); window.fetch = previous.fetch
    history.replaceState(previous.history, '', previous.url)
    document.querySelector<HTMLElement>('#root')!.hidden = false
  } }
}

export async function verifyProLoginPending() {
  const qa = await mountProStatusQA(false), { host, state } = qa
  const entry = host.querySelector('.pro-entry')!, button = entry.querySelector<HTMLButtonElement>('button')!
  let top = entry.getBoundingClientRect().top
  const ready = () => !host.querySelector('[aria-busy="true"]')
  const stable = () => {
    check(host.querySelector('.pro-entry') === entry && button.isConnected, 'Login content must stay mounted while a request is pending')
    check(Math.abs(entry.getBoundingClientRect().top - top) < 1, 'Pending login must not move the content')
    check(button.disabled, 'Pending requests must disable duplicate login clicks')
  }
  try {
    state.hold = true; button.click(); button.click(); button.click()
    await until(() => !ready()); stable()
    check(state.starts === 1, 'Rapid login clicks must send only one OAuth start request')
    check(button.textContent?.includes('GitHub로 이동 중'), 'The login action must explain the pending step')
    const sessions = state.sessions
    window.dispatchEvent(new Event('focus'))
    await new Promise(resolve => setTimeout(resolve, 40))
    check(state.sessions === sessions, 'Focus refresh must not invalidate an in-flight OAuth start')
    state.hold = false; await until(ready)
    check(host.querySelector('.pro-entry') === entry && !button.disabled, 'A failed login must keep the content and allow retry')
    check(host.textContent?.includes('로그인을 시작하지 못했어요.'), 'A failed login must explain how to retry')
    state.loginResponse = 'invalid'; state.hold = true; button.click(); await until(() => !ready())
    check(state.starts === 2, 'A failed request must release the lock for one retry')
    state.hold = false; await until(ready)
    check(!button.disabled && host.textContent?.includes('로그인을 시작하지 못했어요.'), 'An untrusted redirect must be rejected and allow retry')
    top = entry.getBoundingClientRect().top
    state.hold = true; window.dispatchEvent(new Event('focus'))
    await until(() => !ready()); stable()
    state.hold = false; await until(ready)
    state.hold = true; window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })); await until(() => !ready())
    state.hold = false; await until(ready)
    return { passed: true, viewport: innerWidth, checks: ['signed-out refresh', 'pending login content and position', 'rapid click single request', 'focus race', 'failed login retry', 'invalid redirect rejection', 'cache restore refresh'] }
  } finally { qa.cleanup() }
}

export async function verifyProStatusLayout() {
  const qa = await mountProStatusQA(), { host, state } = qa
  const positions = () => ['.pro-layout', '.pro-switcher', '.pro-page-header', '.pro-welcome-card'].map(selector => host.querySelector(selector)!.getBoundingClientRect().top)
  const ready = () => !host.querySelector('[aria-busy="true"]')
  const startRefresh = async () => {
    state.hold = true; window.dispatchEvent(new Event('focus'))
    await until(() => !!host.querySelector('.pro-app[aria-busy="true"]') && host.querySelector('.pro-workspace-status')?.textContent === '확인 중…')
  }
  try {
    const baseline = positions()
    const stable = () => check(positions().every((top, i) => Math.abs(top - baseline[i]!) < 1), 'Status changes must not move workspace content')
    await startRefresh(); stable()
    check(host.querySelector('.pro-session-status')?.textContent === '로그인 확인 중…', 'Session refresh must remain visible')
    state.hold = false; await until(ready); stable()
    const notice = host.querySelector<HTMLDetailsElement>('.pro-service-status')!
    const summary = notice.querySelector<HTMLElement>('summary')!
    summary.click(); check(notice.open, 'Maintenance details must open'); stable()
    const bounds = notice.querySelector('p')!.getBoundingClientRect()
    check(bounds.left >= 0 && bounds.right <= innerWidth, 'Maintenance details must fit the viewport')
    notice.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    check(!notice.open && document.activeElement === summary, 'Escape closes details and restores focus')
    summary.click(); host.querySelector<HTMLElement>('.pro-account a')!.focus()
    check(!notice.open, 'Moving keyboard focus outside must close the notice')
    for (const paused of [false, true]) {
      await startRefresh(); state.paused = paused; state.hold = false
      await until(ready); stable()
      check(!!host.querySelector('.pro-service-status') === paused, 'Maintenance status must reflect the session')
    }
    check(host.scrollWidth <= host.clientWidth, 'No horizontal overflow')
    return { passed: true, viewport: innerWidth, positions: baseline, checks: ['refresh layout', 'maintenance toggle', 'details layout and bounds', 'Escape focus'] }
  } finally { qa.cleanup() }
}
