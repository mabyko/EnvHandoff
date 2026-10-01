// On /tests/pro-qa.html in an isolated local QA browser:
// await (await import('/tests/free-flows.browser.ts')).verifyFreeFlows()
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { SendFlow } from '../src/components/SendFlow.tsx'
import { ReceiveFlow } from '../src/components/ReceiveFlow.tsx'
import { openBundle } from '../src/lib/bundle.ts'

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
    select(new File([source], '.env'))
    await until(() => !!host.querySelector('.picked-file'))
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
