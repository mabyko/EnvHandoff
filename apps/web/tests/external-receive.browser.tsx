import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { deviceHash } from '@envhandoff/protocol/device-proof'
import { ExternalReceive } from '../src/components/ExternalReceive.tsx'
import { createBundle } from '../src/lib/bundle.ts'

const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('External receive UI timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

export async function verifyExternalAcknowledgementRecovery() {
  const source = 'PUBLIC_TEST=fixture\r\n'
  const sealed = await createBundle([{ file: new File([source], '.env'), path: 'apps/web/.env' }], 'QA', 'development')
  const id = crypto.randomUUID(), token = 'public-test-token'
  const info = { id, status: 'available', size: sealed.bytes.byteLength, digest: await deviceHash(new Uint8Array(sealed.bytes)), expiresAt: Date.now() + 60_000, acknowledgedAt: null as number | null }
  const state = { content: 0, ack: 0, failAck: true, holdAck: false, holdPreview: false, unavailable: false, changed: false }
  const previous = { fetch: window.fetch, createURL: URL.createObjectURL, click: HTMLAnchorElement.prototype.click }
  const downloads: Blob[] = [], urls: string[] = []
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  const ready = () => host.querySelector('section[aria-busy="false"]') !== null
  window.fetch = async (input, init) => {
    const path = new URL(String(input), location.href).pathname
    check(new Headers(init?.headers).get('x-share-token') === token, 'Every public operation must retain the link access token')
    if (path === `/shares/${id}`) {
      await until(() => !state.holdPreview)
      return state.unavailable ? new Response(null, { status: 404 }) : Response.json({ ...info, digest: state.changed ? 'changed-fixture-digest' : info.digest })
    }
    if (path === `/shares/${id}/content`) { state.content++; return new Response(sealed.bytes) }
    if (path === `/shares/${id}/ack`) {
      state.ack++; await until(() => !state.holdAck)
      if (state.failAck) return new Response(null, { status: 503 })
      info.acknowledgedAt = Date.now(); return Response.json(info)
    }
    throw new Error('Unexpected external receive request: ' + path)
  }
  URL.createObjectURL = value => { downloads.push(value as Blob); const url = previous.createURL(value); urls.push(url); return url }
  HTMLAnchorElement.prototype.click = function () { if (!this.download) previous.click.call(this) }
  try {
    root.render(createElement(ExternalReceive, { id, token, onHome() {} }))
    await until(() => !!host.querySelector('input[name="share-code"]'))
    const code = host.querySelector<HTMLInputElement>('input[name="share-code"]')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(code, sealed.code)
    code.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => !host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled)
    host.querySelector<HTMLFormElement>('form')!.requestSubmit()
    await until(() => !!button('수신 확인 다시 보내기') && ready())
    const opened = host.querySelector('.received-files')
    check(opened && state.content === 1 && state.ack === 1, 'A failed ACK must preserve authenticated files after one download')
    check(!host.querySelector('input[name="share-code"]'), 'Opened files must not require the cleared sharing code for ACK retry')
    button('다운로드')!.click(); await until(() => downloads.length === 1)
    check(await downloads[0]!.text() === source, 'ACK failure must still permit unchanged original file downloads')

    state.changed = true; button('수신 확인 다시 보내기')!.click()
    await until(() => !!host.querySelector('[role="alert"]') && ready())
    check(state.ack === 1 && state.content === 1 && host.querySelector('.received-files') === opened, 'A changed share digest must block ACK without replacing the opened files')
    state.changed = false; state.unavailable = true; state.holdPreview = true; button('수신 확인 다시 보내기')!.click()
    await until(() => !!button('수신 확인 보내는 중…')?.disabled)
    state.holdPreview = false
    await until(() => !!button('수신 확인 다시 보내기') && ready())
    check(state.ack === 1 && state.content === 1 && !!button('다운로드'), 'Revoked or unavailable sharing must block ACK but cannot retract an already opened copy')
    state.unavailable = false; state.failAck = false; state.holdAck = true
    const retry = button('수신 확인 다시 보내기')!
    retry.click(); retry.click(); retry.click()
    await until(() => state.ack === 2 && !!button('수신 확인 보내는 중…')?.disabled)
    check(button('수신 확인 보내는 중…')?.disabled, 'Pending ACK must prevent duplicate retries')
    state.holdAck = false
    await until(() => !button('수신 확인 다시 보내기') && ready())
    check(state.ack === 2 && state.content === 1 && host.querySelector('.received-files') === opened, 'ACK-only retry must never re-download or replace the opened bundle')
    check(host.textContent?.includes('수신 확인을 남겼어요.'), 'Successful retry must report the recorded ACK')
    button('열어둔 파일 닫기')!.click(); await until(() => !!host.querySelector('input[name="share-code"]'))
    check(host.querySelector<HTMLInputElement>('input[name="share-code"]')!.value === '', 'Closing files must not restore the sharing code')
    check(!button('수신 확인 다시 보내기'), 'Closing the plaintext must clear its ACK retry state')
    return { passed: true, checks: ['authenticated originals retained after ACK failure', 'digest and availability revalidation', 'one concurrent ACK-only retry', 'no repeated content download', 'sharing code and retry state cleared'] }
  } finally {
    state.holdAck = false; state.holdPreview = false; root.unmount(); host.remove()
    window.fetch = previous.fetch; URL.createObjectURL = previous.createURL; HTMLAnchorElement.prototype.click = previous.click
    for (const url of urls) URL.revokeObjectURL(url)
  }
}
