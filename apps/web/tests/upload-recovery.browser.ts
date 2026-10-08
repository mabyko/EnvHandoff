// Run on the isolated local Vite QA page.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ProShares } from '../src/components/ProShares.tsx'
import { ProRequests } from '../src/components/ProRequests.tsx'

export async function verifyShareReservationRecovery() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch
  const orgId = crypto.randomUUID(), userId = crypto.randomUUID(), environmentId = crypto.randomUUID()
  const api = '/__reservation-regression', ids: string[] = []
  let status = 429, errorCode = 'storage_limit', acceptNewTransfers = true
  const until = async (condition: () => boolean) => {
    const end = Date.now() + 5000
    while (!condition()) { if (Date.now() > end) throw new Error('Reservation check timed out'); await new Promise(resolve => setTimeout(resolve, 20)) }
  }
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
  const button = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.includes('암호화해서 외부 공유') || node.textContent === '같은 업로드 재시도')!
  const render = () => root.render(createElement(ProShares, { api, orgId, userId, csrf: 'test-only', route: { page: 'shares', orgId, create: true }, onNavigate() {}, disabled: false, acceptNewTransfers, onExpired() {} }))
  window.fetch = async (input, init) => {
    if (String(input).endsWith('/catalog')) return Response.json({ projects: [{ name: 'QA', environments: [{ id: environmentId, name: 'development', permissions: { externalShare: true } }] }] })
    if (String(input).endsWith('/shares') && init?.method === 'POST') {
      ids.push(JSON.parse(init.body as string).operationId)
      return Response.json({ error: errorCode }, { status })
    }
    throw new Error('Unexpected reservation request')
  }
  try {
    render(); await until(() => !!host.querySelector('input[type="file"]') && !host.querySelector('[aria-busy="true"]'))
    const data = new DataTransfer(); data.items.add(new File(['PUBLIC_TEST=fixture\n'], '.env'))
    const file = host.querySelector<HTMLInputElement>('input[type="file"]')!; file.files = data.files; file.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => !button().disabled)
    button().click(); await until(() => ids.length === 1 && !host.querySelector('[aria-busy="true"]'))
    check(!file.disabled && !file.matches(':disabled'), 'Definitive reservation rejection must unlock the selected file')
    check(host.querySelector<HTMLInputElement>('input:not([type="file"])')?.value === '.env', 'Rejection must retain the source and placement path')
    status = 503; errorCode = 'beta_closed'; button().click(); await until(() => ids.length === 2 && !host.querySelector('[aria-busy="true"]'))
    check(!file.disabled && host.textContent?.includes('일시 중지'), 'Explicit beta closure must explain the cause and unlock the nonexistent upload despite HTTP 503')
    errorCode = 'storage_unavailable'; button().click(); await until(() => ids.length === 3 && !host.querySelector('[aria-busy="true"]'))
    check(file.disabled && button().textContent === '같은 업로드 재시도', 'Unknown outcome must retain encrypted retry state')
    button().click(); await until(() => ids.length === 4 && !host.querySelector('[aria-busy="true"]'))
    check(ids[0] !== ids[1] && ids[1] !== ids[2] && ids[2] === ids[3], 'Fresh reservation after rejection, stable ID after unknown outcome')
    acceptNewTransfers = false; render(); await until(() => button().disabled)
    check(host.textContent?.includes('일시 중지'), 'Paused service must explain why new upload is disabled')
    check([...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === '업로드 상태 확인')?.disabled === false, 'Paused service must preserve recovery controls')
    return { passed: true, checks: ['rejection unlocks originals', 'uncertain outcome retains operation ID', 'paused uploads with recovery available'] }
  } finally { root.unmount(); host.remove(); window.fetch = originalFetch }
}

export async function verifyPausedRequests() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch
  const orgId = crypto.randomUUID(), userId = crypto.randomUUID(), environmentId = crypto.randomUUID()
  let acceptNewTransfers = false
  const until = async (condition: () => boolean) => {
    const end = Date.now() + 5000
    while (!condition()) { if (Date.now() > end) throw new Error('Paused requests timed out'); await new Promise(resolve => setTimeout(resolve, 20)) }
  }
  const render = () => root.render(createElement(ProRequests, { api: '/__paused-request', orgId, userId, csrf: 'test-only', route: { page: 'requests', orgId, create: true }, onNavigate() {}, disabled: false, acceptNewTransfers, onExpired() {} }))
  window.fetch = async (input, init) => {
    if (init?.method === 'POST') throw new Error('Paused request must not POST')
    if (String(input).endsWith('/catalog')) return Response.json({ projects: [{ name: 'QA', environments: [{ id: environmentId, name: 'development', permissions: { receive: true } }] }] })
    if (String(input).includes('/requests/options?')) return Response.json({ senders: [{ id: crypto.randomUUID(), login: 'qa-sender' }] })
    throw new Error('Unexpected paused request')
  }
  try {
    render(); await until(() => !!host.querySelector('form button[type="submit"]') && !host.querySelector('[aria-busy="true"]') && !!host.querySelector('#request-sender option'))
    const button = host.querySelector<HTMLButtonElement>('form button[type="submit"]')!
    if (!button.disabled || !host.textContent?.includes('일시 중지')) throw new Error('Paused requests must explain the cause and disable creation')
    button.click()
    acceptNewTransfers = true; render(); await until(() => !button.disabled)
    return { passed: true, checks: ['paused creation disabled', 'resume enables creation'] }
  } finally { root.unmount(); host.remove(); window.fetch = originalFetch }
}
