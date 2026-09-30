// Run in an isolated QA browser on the Vite dev origin:
// await (await import('/tests/pro-security.browser.ts')).verifyFactorRemoval()
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ProSecurity } from '../src/components/ProSecurity.tsx'

export async function verifyFactorRemoval() {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), originalFetch = window.fetch, originalConfirm = window.confirm
  const api = '/__security-regression', userId = crypto.randomUUID()
  const state = { passkeys: [{ id: 'test-key', label: '내 패스키' }], totp: false, totpAvailable: true, reauthenticatedUntil: 0, sessionHash: 'test-only', canRegisterDevice: false, devices: [] }
  let requests = 0, confirmations = 0
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
  const until = async (condition: () => boolean) => {
    const end = Date.now() + 5000
    while (!condition()) {
      if (Date.now() > end) throw new Error('Security UI check timed out')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const ready = () => !!container.querySelector('fieldset') && !container.querySelector('[aria-busy="true"]')
  const buttons = () => [...container.querySelectorAll<HTMLButtonElement>('button')].filter(button => ['삭제', '인증 앱 삭제'].includes(button.textContent!))
  const refresh = async () => {
    const previous = requests
    const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '보안 상태 다시 조회')!
    button.click(); button.click(); button.click()
    await until(() => requests > previous && ready())
    check(requests === previous + 1, 'Rapid refresh clicks must share one security request')
  }
  const blocked = (reason: string) => {
    check(buttons().length > 0, 'Missing removal buttons')
    check(buttons().every(button => button.disabled), `Unavailable factor removal must be disabled before clicking (${state.passkeys.length} passkeys, TOTP ${state.totp}, ${reason})`)
    check(container.textContent!.includes(reason), 'Missing removal prerequisite explanation')
    const before = confirmations
    for (const button of buttons()) button.click()
    check(confirmations === before, 'Blocked removal must not open a confirmation')
  }
  window.confirm = () => { confirmations++; return true }
  window.fetch = async (input, init) => {
    const url = String(input)
    if (!url.startsWith(api)) return originalFetch(input, init)
    requests++
    if (url === api + '/security') return Response.json(state)
    check(state.reauthenticatedUntil > Date.now(), 'Removal sent without reauthentication')
    check(state.passkeys.length + Number(state.totp) > 1, 'Removal sent for the last factor')
    if (url.endsWith('/passkeys/remove')) state.passkeys = state.passkeys.filter(key => key.id !== JSON.parse(init!.body as string).id)
    else if (url.endsWith('/totp/remove')) state.totp = false
    else throw new Error('Unexpected security request')
    state.reauthenticatedUntil = 0
    return Response.json({ ok: true })
  }
  try {
    root.render(createElement(ProSecurity, { api, userId, csrf: 'test-only', disabled: false, onExpired: () => { throw new Error('Unexpected expiry') }, onDeleted: () => { throw new Error('Unexpected deletion') } }))
    await until(ready)
    blocked('마지막 인증 수단')
    state.reauthenticatedUntil = Date.now() + 60_000; await refresh(); blocked('마지막 인증 수단')
    state.passkeys = []; state.totp = true; await refresh(); blocked('마지막 인증 수단')
    state.passkeys = [{ id: 'test-key', label: '내 패스키' }]; state.reauthenticatedUntil = 0; await refresh(); blocked('먼저 본인 확인')
    state.reauthenticatedUntil = Date.now() + 60_000; await refresh()
    check(buttons().every(button => !button.disabled), 'Verified redundant factors should be removable')
    const removal = buttons()[0]!
    removal.click(); removal.click(); removal.click(); await until(() => !state.passkeys.length && ready() && buttons().length === 1 && buttons()[0]!.textContent === '인증 앱 삭제')
    blocked('마지막 인증 수단')
    state.passkeys = [{ id: 'test-key', label: '내 패스키' }]; state.reauthenticatedUntil = Date.now() + 60_000; await refresh()
    buttons().find(button => button.textContent === '인증 앱 삭제')!.click(); await until(() => !state.totp && ready() && buttons().length === 1 && buttons()[0]!.textContent === '삭제')
    blocked('마지막 인증 수단')
    state.totp = true; state.reauthenticatedUntil = Date.now() + 200; await refresh()
    await until(() => buttons().every(button => button.disabled)); blocked('먼저 본인 확인')
    check(confirmations === 2, 'Only the two eligible removals should need confirmation')
    return { passed: true, checks: ['last passkey', 'last TOTP', 'reauthentication required', 'eligible passkey and TOTP removal', 'reauthentication expiry', 'rapid refresh and removal click prevention'] }
  } finally { root.unmount(); window.fetch = originalFetch; window.confirm = originalConfirm; container.remove() }
}
