// On /tests/pro-qa.html in an isolated local QA browser:
// await (await import('/tests/free-flows.browser.ts')).verifyFreeFlows()
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { SendFlow } from '../src/components/SendFlow.tsx'
import { OpenedFiles, ReceiveFlow } from '../src/components/ReceiveFlow.tsx'
import { openBundle } from '../src/lib/bundle.ts'
import App from '../src/App.tsx'

const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
async function until(condition: () => boolean) {
  const end = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > end) throw new Error('Free flow check timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

export async function verifyFreeFlows() {
  const host = document.createElement('div'); host.className = 'work-card'; document.body.append(host)
  const root = createRoot(host), originalCreateURL = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click
  const downloads: Blob[] = [], urls: string[] = []
  URL.createObjectURL = object => { downloads.push(object as Blob); const url = originalCreateURL(object); urls.push(url); return url }
  HTMLAnchorElement.prototype.click = function () { if (!this.download) originalClick.call(this) }
  const input = (selector: string, value: string) => {
    const node = host.querySelector<HTMLInputElement>(selector)!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const select = (file: File) => {
    const node = host.querySelector<HTMLInputElement>('input[type="file"]')!, data = new DataTransfer()
    data.items.add(file); node.files = data.files; node.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const submit = () => host.querySelector<HTMLFormElement>('form')!.requestSubmit()
  const click = (text: string) => {
    const node = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)
    check(node, 'Missing action: ' + text); node!.click()
  }
  try {
    const source = 'DEMO_VALUE=public-fixture\r\n'
    root.render(createElement(SendFlow, { onHome() {} }))
    await until(() => !!host.querySelector('input[type="file"]'))
    check(host.querySelectorAll('.steps li').length === 2, 'Sending requires only two steps')
    check(!host.querySelector<HTMLDetailsElement>('.share-options')!.open, 'Optional settings start collapsed')
    check(!host.querySelector('.method-options')!.closest('details'), 'Delivery methods must be available without opening metadata settings')
    check(host.querySelector<HTMLInputElement>('input[name="method"][value="file"]')!.checked, 'File delivery remains the default')
    select(new File([source], '.env'))
    await until(() => !!host.querySelector('.picked-file'))
    check(!!host.querySelector('[data-work-loss="true"]'), 'Selected files must participate in navigation protection')
    const sendingUnload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(sendingUnload)
    check(sendingUnload.defaultPrevented, 'Selected files must warn before reload')
    submit(); await until(() => !!host.querySelector('.task-card'))
    const code = host.querySelector<HTMLInputElement>('.copy-field input')!.value
    click('공유 파일 다운로드'); await until(() => downloads.length === 1)
    const encrypted = await downloads[0]!.arrayBuffer(), bundle = await openBundle(encrypted, code)
    check(bundle.projectLabel === '설정 공유' && bundle.environment === 'development', 'Files-only sharing uses valid metadata defaults')
    check(new TextDecoder().decode(bundle.files[0]!.bytes) === source, 'Encryption preserves original line endings')
    host.querySelector<HTMLButtonElement>('.steps button')!.click()
    await until(() => !!host.querySelector('.picked-file'))
    input('.path-input', '../.env'); await until(() => host.querySelector<HTMLInputElement>('.path-input')!.value === '../.env')
    submit(); await until(() => !!host.querySelector('[role="alert"]'))
    check(!host.querySelector('.task-card'), 'Invalid placement paths never proceed to delivery')
    input('.path-input', '.env')
    host.querySelector<HTMLElement>('.env-editor summary')!.click()
    input('[id^="env-key-"]', 'DEMO_PENDING')
    await until(() => host.querySelector<HTMLInputElement>('[id^="env-key-"]')!.value === 'DEMO_PENDING')
    submit(); await until(() => !!host.querySelector('.env-editor [role="alert"]'))
    check(!host.querySelector('.task-card'), 'Uncommitted variable input must not be silently omitted')
    input('[id^="env-key-"]', '')
    host.querySelector<HTMLElement>('.share-options summary')!.click()
    input('#project', 'QA project'); input('#environment', 'staging')
    await until(() => host.querySelector<HTMLInputElement>('#environment')!.value === 'staging')
    submit(); await until(() => !!host.querySelector('.task-card'))
    const customCode = host.querySelector<HTMLInputElement>('.copy-field input')!.value
    click('공유 파일 다운로드'); await until(() => downloads.length === 2)
    const custom = await openBundle(await downloads[1]!.arrayBuffer(), customCode)
    check(custom.projectLabel === 'QA project' && custom.environment === 'staging', 'Optional metadata is retained in the encrypted bundle')
    root.render(createElement(ReceiveFlow, { onHome() {} }))
    await until(() => !!host.querySelector('input[name="share-code"]'))
    select(new File([encrypted], 'public-fixture.envhandoff'))
    input('input[name="share-code"]', 'A'.repeat(43))
    await until(() => !host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled)
    submit(); await until(() => !!host.querySelector('[role="alert"]'))
    check(!host.querySelector('.received-files') && !!host.querySelector('.file-picker.chosen'), 'A wrong code reveals no files and preserves the selection for retry')
    input('input[name="share-code"]', code)
    await until(() => !host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled)
    submit(); await until(() => !!host.querySelector('.received-files'))
    check(!!host.querySelector('[data-work-loss="true"]'), 'Opened plaintext must participate in navigation protection')
    const receivingUnload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(receivingUnload)
    check(receivingUnload.defaultPrevented, 'Opened plaintext must warn before reload')
    check(!host.querySelector('.preview'), 'File content stays hidden until requested')
    check(host.querySelector('h1')?.textContent === '이제 프로젝트에 넣어주세요', 'Receiving explains the remaining manual placement step')
    click('다운로드'); await until(() => downloads.length === 3)
    check(await downloads[2]!.text() === source, 'Receiving downloads the unchanged original file')
    return { passed: true, checks: ['files-only encrypted roundtrip', 'metadata defaults and custom values', 'invalid path refusal', 'uncommitted input guard', 'wrong-code retry without disclosure', 'manual placement guidance', 'original download bytes'] }
  } finally {
    root.unmount(); host.remove(); URL.createObjectURL = originalCreateURL; HTMLAnchorElement.prototype.click = originalClick
    for (const url of urls) URL.revokeObjectURL(url)
  }
}

export async function verifyFreeNavigationGuard() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalConfirm = window.confirm, originalURL = location.href
  let confirmations = 0, leave = false
  window.confirm = () => { confirmations++; return leave }
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)!
  try {
    history.replaceState(null, '', '/')
    root.render(createElement(App)); await until(() => !!host.querySelector('.landing-hero'))
    host.querySelector<HTMLButtonElement>('.landing-hero button.primary')!.click()
    await until(() => !!host.querySelector('input[type="file"]'))
    button('홈으로').click(); await until(() => !!host.querySelector('.landing-hero'))
    check(confirmations === 0, 'Empty sender must navigate without confirmation')
    host.querySelector<HTMLButtonElement>('.landing-hero button.primary')!.click()
    await until(() => !!host.querySelector('input[type="file"]'))
    const data = new DataTransfer(); data.items.add(new File(['PUBLIC=fixture\n'], '.env'))
    const file = host.querySelector<HTMLInputElement>('input[type="file"]')!; file.files = data.files; file.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => !!host.querySelector('.picked-file'))
    button('홈으로').click(); await new Promise(resolve => setTimeout(resolve, 30))
    check(confirmations === 1 && !!host.querySelector('.picked-file'), 'Declining home navigation must preserve the selected file')
    history.replaceState(null, '', '/#receive-invalid'); window.dispatchEvent(new HashChangeEvent('hashchange'))
    await until(() => confirmations === 2)
    check(!!host.querySelector('.picked-file') && location.hash === '' && location.pathname === '/send', 'Declining a receive link must preserve sender work and restore its safe URL')
    leave = true; button('홈으로').click(); await until(() => !!host.querySelector('.landing-hero'))
    const cleanUnload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(cleanUnload)
    check(!cleanUnload.defaultPrevented, 'Leaving the flow must remove its unload listener')
    return { passed: true, checks: ['empty flow navigation', 'home guard retains files', 'receive link guard', 'unload cleanup'] }
  } finally { root.unmount(); host.remove(); window.confirm = originalConfirm; history.replaceState(null, '', originalURL) }
}

export async function verifyFreeBrowserHistory() {
  const host = document.createElement('div'); document.body.append(host)
  let root = createRoot(host)
  const originalConfirm = window.confirm, originalURL = location.href, originalState = history.state
  let confirmations = 0, leave = false
  window.confirm = () => { confirmations++; return leave }
  const click = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === text)!.click()
  try {
    history.replaceState({ fixture: 'public-marker' }, '', '/')
    root.render(createElement(App)); await until(() => !!host.querySelector('.landing-hero'))
    click('설정 파일 보내기'); await until(() => !!host.querySelector('input[type="file"]'))
    check(location.pathname === '/send' && history.state.fixture === 'public-marker', 'Free navigation records a safe path and preserves unrelated history state')
    const data = new DataTransfer(); data.items.add(new File(['PUBLIC=fixture\n'], '.env'))
    const file = host.querySelector<HTMLInputElement>('input[type="file"]')!; file.files = data.files; file.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => !!host.querySelector('.picked-file'))
    const selection = host.querySelector('.picked-file'), index = history.state.envhandoffFreeIndex
    history.back()
    await until(() => confirmations === 1 && history.state?.envhandoffFreeIndex === index)
    check(location.pathname === '/send' && host.querySelector('.picked-file') === selection, 'Declining browser Back restores the exact selection and URL without remounting')
    check(!JSON.stringify(history.state).includes('.env'), 'File metadata must never enter history state')
    leave = true; history.back(); await until(() => !!host.querySelector('.landing-hero'))
    check(location.pathname === '/', 'Accepting Back returns to the previous app screen')
    history.forward(); await until(() => !!host.querySelector('input[type="file"]'))
    check(location.pathname === '/send' && !host.querySelector('.picked-file'), 'Forward restores the sender screen without retaining secret work')
    history.back(); await until(() => !!host.querySelector('.landing-hero'))
    click('받은 공유 파일 열기'); await until(() => !!host.querySelector('input[name="share-code"]'))
    check(location.pathname === '/receive', 'File receiving has a safe reloadable route')
    history.back(); await until(() => !!host.querySelector('.landing-hero'))
    history.forward(); await until(() => !!host.querySelector('input[name="share-code"]'))
    const codeInput = host.querySelector<HTMLInputElement>('input[name="share-code"]')!, code = 'Q'.repeat(43)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(codeInput, code)
    codeInput.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => !!host.querySelector('[data-work-loss="true"]'))
    const receivingIndex = history.state.envhandoffFreeIndex, previousConfirmations = confirmations
    leave = false; history.back()
    await until(() => confirmations === previousConfirmations + 1 && history.state?.envhandoffFreeIndex === receivingIndex)
    check(host.querySelector('input[name="share-code"]') === codeInput && codeInput.value === code, 'Declining receiver Back preserves its exact in-memory code')
    check(!JSON.stringify(history.state).includes(code), 'Shared codes must never enter browser history')
    root.unmount()
    root = createRoot(host)
    root.render(createElement(App)); await until(() => !!host.querySelector('input[name="share-code"]'))
    check(!host.querySelector('[data-work-loss="true"]'), 'Remounting a safe receiving route must not recover file content or codes')
    return { passed: true, checks: ['safe routes and existing history state', 'declined Back preserves exact work', 'accepted Back', 'Forward without secret recovery', 'receiving Back and Forward', 'reload-equivalent route restoration'] }
  } finally { root.unmount(); host.remove(); window.confirm = originalConfirm; history.replaceState(originalState, '', originalURL) }
}

export async function verifyDownloadPlacement() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalCreateURL = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click
  const originalCopy = navigator.clipboard.writeText, downloads: Blob[] = [], names: string[] = [], urls: string[] = [], copied: string[] = []
  navigator.clipboard.writeText = async value => { copied.push(value) }
  URL.createObjectURL = object => { downloads.push(object as Blob); const url = originalCreateURL(object); urls.push(url); return url }
  HTMLAnchorElement.prototype.click = function () { if (this.download) names.push(this.download); else originalClick.call(this) }
  try {
    const paths = ['apps/api/.env', 'apps/web/.env'], values = ['PUBLIC_API=1\r\n', 'PUBLIC_WEB=2\n']
    root.render(createElement(OpenedFiles, { bundle: { bundleId: 'public-qa', projectLabel: 'QA', environment: 'development', createdAt: new Date().toISOString(), files: paths.map((path, index) => ({ path, bytes: new TextEncoder().encode(values[index]) })) } }))
    await until(() => host.querySelectorAll('.received-file').length === 2)
    check(host.querySelectorAll('.received-file .notice').length === 2, 'Same basenames at different paths must explain browser filename changes and manual placement')
    for (const section of host.querySelectorAll('.received-file')) {
      section.querySelector<HTMLButtonElement>('.copy-field .button')!.click()
      section.querySelector<HTMLButtonElement>('.file-actions .button')!.click()
    }
    await until(() => downloads.length === 2 && copied.length === 2 && host.textContent!.includes('다운로드 요청함'))
    check(copied.join('|') === paths.join('|'), 'Copying placement paths must preserve their full repository-relative paths')
    check(names.every(name => name === '.env'), 'Downloads must preserve original filenames rather than inventing path encodings')
    check((await Promise.all(downloads.map(blob => blob.text()))).every((value, index) => value === values[index]), 'Downloads must preserve distinct original bytes and line endings')
    check(!host.querySelector('.preview') && !host.textContent!.includes('PUBLIC_API'), 'Placement guidance must not reveal file contents by default')
    return { passed: true, checks: ['same filename warning', 'path copying', 'original filenames and bytes', 'download-request semantics', 'hidden file content'] }
  } finally {
    root.unmount(); host.remove(); navigator.clipboard.writeText = originalCopy; URL.createObjectURL = originalCreateURL; HTMLAnchorElement.prototype.click = originalClick
    for (const url of urls) URL.revokeObjectURL(url)
  }
}

export async function verifyExternalSkipLinkNavigation() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch, originalConfirm = window.confirm, originalURL = location.href, originalState = history.state
  const id = '30000000-0000-4000-8000-000000000001', token = 'A'.repeat(43), code = 'Q'.repeat(43)
  let previews = 0, confirmations = 0, leave = false
  window.confirm = () => { confirmations++; return leave }
  window.fetch = async (input, init) => {
    if (new URL(String(input), location.href).pathname.endsWith('/shares/' + id)) {
      check(new Headers(init?.headers).get('x-share-token') === token, 'Preview requests use only the originally supplied token')
      previews++
      return Response.json({ id, status: 'available', size: 40, digest: 'public-fixture', expiresAt: Date.now() + 60_000, acknowledgedAt: null })
    }
    throw new Error('Unexpected external navigation request')
  }
  const settled = () => new Promise(resolve => setTimeout(resolve, 60))
  try {
    history.replaceState({ envhandoffFreeIndex: 0 }, '', '/')
    history.pushState({ envhandoffFreeIndex: 1 }, '', `/receive/${id}#token=${token}`)
    root.render(createElement(App)); await until(() => previews === 1 && !!host.querySelector('input[name="share-code"]'))
    const input = host.querySelector<HTMLInputElement>('input[name="share-code"]')!, receiver = host.querySelector('[data-work-loss]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, code)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => input.value === code)
    check(location.hash === '' && !JSON.stringify(history.state).includes(token), 'Incoming credentials are removed from the URL and history state')
    host.querySelector<HTMLAnchorElement>('.pro-skip-link')!.click()
    await until(() => location.hash === '#main-content'); await settled()
    check(confirmations === 0 && previews === 1 && host.querySelector('[data-work-loss]') === receiver && host.querySelector('input[name="share-code"]') === input && input.value === code, 'Skip links must retain the exact external receiver, token, and entered code without a work-loss prompt')
    history.back(); await until(() => location.hash === ''); await settled()
    history.forward(); await until(() => location.hash === '#main-content'); await settled()
    check(confirmations === 0 && previews === 1 && host.querySelector('input[name="share-code"]') === input && input.value === code, 'Anchor Back and Forward must preserve the current external receiver')
    history.back(); await until(() => location.hash === ''); await settled()
    const index = history.state.envhandoffFreeIndex
    history.back(); await until(() => confirmations === 1 && history.state?.envhandoffFreeIndex === index)
    check(location.pathname === `/receive/${id}` && host.querySelector('input[name="share-code"]') === input && input.value === code, 'Declining real Back after an anchor restores the exact external work and history position')
    history.forward(); await until(() => location.hash === '#main-content'); await settled()
    const home = [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === '홈으로')!
    home.click(); await until(() => confirmations === 2)
    check(host.querySelector('input[name="share-code"]') === input && input.value === code, 'Actual screen navigation still guards external secrets')
    leave = true; home.click(); await until(() => !!host.querySelector('.landing-hero'))
    history.back(); await until(() => !!host.querySelector('[role="alert"]')); await settled()
    check(!host.querySelector('input[name="share-code"]') && previews === 1, 'Back after leaving cannot restore an external token or code from history')
    location.hash = '#token=malformed'; await until(() => location.hash === ''); await settled()
    check(!!host.querySelector('[role="alert"]') && previews === 1, 'Malformed incoming tokens still produce the safe missing-link state and clear their fragment')
    return { passed: true, checks: ['credential fragment removal', 'external skip-link DOM and code retention', 'anchor Back and Forward', 'declined real Back after anchors', 'real navigation guard', 'no token restoration on Back', 'malformed token refusal'] }
  } finally { root.unmount(); host.remove(); window.fetch = originalFetch; window.confirm = originalConfirm; history.replaceState(originalState, '', originalURL) }
}
