// Isolated Vite QA: synthetic files/accounts and mocked API; real React and device crypto.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { deviceIdentity, identityFingerprint } from '@envhandoff/protocol/device-proof'
import { createLocalDevice, deleteLocalDevice, pinPeerIdentity } from '../src/lib/device-keys.ts'
import { ProRequests } from '../src/components/ProRequests.tsx'
import { ProShares } from '../src/components/ProShares.tsx'

const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
async function until(condition: () => boolean) {
  const end = Date.now() + 5000
  do {
    await new Promise(resolve => setTimeout(resolve, 20))
    if (condition()) return
  } while (Date.now() < end)
  throw new Error('Refresh regression timed out')
}

export async function verifyRequestSenderRefresh() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch
  const orgId = crypto.randomUUID(), environmentId = crypto.randomUUID(), userId = crypto.randomUUID()
  const first = { id: crypto.randomUUID(), login: 'first' }, second = { id: crypto.randomUUID(), login: 'chosen' }
  let options = 0, senders = [first, second]
  const ready = () => !host.querySelector('[aria-busy="true"]') && !!host.querySelector('#request-sender') && !host.querySelector<HTMLSelectElement>('#request-sender')!.disabled
  window.fetch = async (input, init) => {
    if (!String(input).startsWith('/__refresh-qa')) return originalFetch(input, init)
    if (String(input).includes('/options?')) { options++; return Response.json({ senders }) }
    return Response.json({ projects: [{ name: 'QA', environments: [{ id: environmentId, name: 'dev', permissions: { receive: true } }] }] })
  }
  try {
    root.render(createElement(ProRequests, { api: '/__refresh-qa', orgId, userId, csrf: 'test-only', disabled: false, route: { page: 'requests', orgId, create: true }, onNavigate: () => {}, onExpired: () => {} }))
    await until(ready)
    const select = host.querySelector<HTMLSelectElement>('#request-sender')!
    select.value = second.id; select.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => select.value === second.id)
    window.dispatchEvent(new Event('focus'))
    await until(() => options >= 2 && ready())
    check(select.value === second.id, 'Tab return must preserve the chosen sender, not silently select the first person')
    senders = [first]; window.dispatchEvent(new Event('focus'))
    await until(() => options >= 3 && ready())
    check(select.value !== first.id, 'Losing sender eligibility must require an explicit replacement')
    check(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, 'Unavailable selected sender must block creation')
    return { passed: true, checks: ['preserve sender on refresh', 'require replacement for unavailable sender'] }
  } finally { root.unmount(); window.fetch = originalFetch; host.remove() }
}

export async function verifyShareEnvironmentRefresh(page: 'shares' | 'requests' = 'shares') {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch
  const orgId = crypto.randomUUID(), userId = crypto.randomUUID(), first = crypto.randomUUID(), selected = crypto.randomUUID()
  let reads = 0, ids = [first, selected]
  const ready = () => !!host.querySelector('select') && !host.querySelector('[aria-busy="true"]')
  window.fetch = async (input, init) => {
    if (!String(input).startsWith('/__refresh-qa')) return originalFetch(input, init)
    if (String(input).includes('/options?')) return Response.json({ senders: [{ id: crypto.randomUUID(), login: 'sender' }] })
    reads++
    return Response.json({ projects: [{ name: 'QA', environments: ids.map(id => ({ id, name: id === first ? 'dev' : 'production', permissions: { externalShare: true, receive: true } })) }] })
  }
  try {
    root.render(createElement(page === 'shares' ? ProShares : ProRequests, { api: '/__refresh-qa', orgId, userId, csrf: 'test-only', disabled: false, route: { page, orgId, create: true }, onNavigate: () => {}, onExpired: () => {} }))
    await until(ready)
    const select = host.querySelector<HTMLSelectElement>('select')!
    select.value = selected; select.dispatchEvent(new Event('change', { bubbles: true }))
    if (page === 'shares') {
      const files = new DataTransfer(); files.items.add(new File(['PUBLIC_TEST=not-a-secret\n'], '.env.production'))
      const input = host.querySelector<HTMLInputElement>('input[type="file"]')!; input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }))
      await until(() => !!host.querySelector('[data-work-loss="true"]'))
    } else await until(() => select.value === selected)
    ids = [first]; window.dispatchEvent(new Event('focus'))
    await until(() => reads >= 2 && ready())
    check(select.value !== first, 'Permission removal must not silently move the selected file to a different environment')
    check([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === (page === 'shares' ? '암호화해서 외부 공유' : '파일 요청'))!.disabled, 'Unavailable environment must block creation')
    window.dispatchEvent(new Event('focus')); await until(() => reads >= 3 && ready())
    check(select.value !== first && (page === 'requests' || !!host.querySelector('[data-work-loss="true"]')), 'Repeated refresh must retain the original selection and file')
    return { passed: true, page, checks: ['no implicit environment switch after permission loss', 'repeated refresh keeps selection'] }
  } finally { root.unmount(); window.fetch = originalFetch; host.remove() }
}

export const verifyRequestEnvironmentRefresh = () => verifyShareEnvironmentRefresh('requests')

export async function verifyRequestRefreshPreservesUpload() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch
  const orgId = crypto.randomUUID(), userId = crypto.randomUUID(), recipientId = crypto.randomUUID(), requestId = crypto.randomUUID()
  const api = '/__refresh-qa', base = api + `/organizations/${orgId}/requests/${requestId}`
  let status = 200, reads = 0
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!
  const ready = () => !host.querySelector('[aria-busy="true"]')
  try {
    await createLocalDevice(userId, crypto.randomUUID())
    const recipient = await createLocalDevice(recipientId, crypto.randomUUID())
    const peer = await deviceIdentity(recipientId, recipient.deviceId, recipient.keys.publicKey, recipient.signingKeys.publicKey)
    await pinPeerIdentity(userId, peer, await identityFingerprint(peer))
    window.fetch = async (input, init) => {
      const path = String(input)
      if (path === base) {
        reads++
        return status === 200 ? Response.json({ id: requestId, status: 'approved', direction: 'incoming', createdAt: 1, expiresAt: Date.now() + 86400000, project: 'QA', environment: 'dev' }) : Response.json({ error: status === 403 ? 'file_permission_required' : 'service_unavailable' }, { status })
      }
      if (path === base + '/transfer') return Response.json({ organizationId: orgId, requestId, senderUserId: userId, recipientUserId: recipientId, recipientDeviceId: recipient.deviceId, receiver: peer })
      return originalFetch(input, init)
    }
    root.render(createElement(ProRequests, { api, orgId, userId, csrf: 'test-only', disabled: false, route: { page: 'requests', orgId, id: requestId }, onNavigate: () => {}, onExpired: () => {} }))
    await until(() => !!button('상대 기기 확인') && ready())
    button('상대 기기 확인').click(); await until(() => !!host.querySelector('input[type="file"]') && ready())
    const files = new DataTransfer(); files.items.add(new File(['PUBLIC_TEST=not-a-secret\n'], '.env'))
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!; input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => !!host.querySelector('[data-work-loss="true"]'))
    status = 503; window.dispatchEvent(new Event('focus')); await until(() => reads >= 2 && ready())
    check(host.contains(input) && !!host.querySelector('[data-work-loss="true"]'), 'A transient refresh error must preserve the actual transfer editor and its file')
    check(button('암호화해서 업로드').matches(':disabled'), 'Actions must stay locked until the current request can be verified')
    status = 200; button('새로고침').click(); await until(() => reads >= 3 && ready())
    check(host.contains(input) && !button('암호화해서 업로드').matches(':disabled'), 'Successful retry must restore actions without losing the file')
    status = 403; button('새로고침').click(); await until(() => reads >= 4 && ready())
    check(!host.querySelector('.pro-transfer'), 'A definitive access denial must remove the transfer editor')
    return { passed: true, checks: ['transient failure retains file/editor', 'failed verification locks actions', 'retry restores editor', 'confirmed denial clears editor'] }
  } finally { root.unmount(); window.fetch = originalFetch; host.remove(); await deleteLocalDevice(userId); await deleteLocalDevice(recipientId) }
}
