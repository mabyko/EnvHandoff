// Isolated Vite/Chrome QA: (await import('/tests/pro-transfer.browser.tsx')).verifyTransferCancellation()
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { deviceIdentity, identityFingerprint } from '@envhandoff/protocol/device-proof'
import { createLocalDevice, deleteLocalDevice, pinPeerIdentity } from '../src/lib/device-keys.ts'
import { ProTransfer } from '../src/components/ProTransfer.tsx'

export async function verifyTransferCancellation(rejectReservation = false) {
  const userId = crypto.randomUUID(), recipientId = crypto.randomUUID(), orgId = crypto.randomUUID(), requestId = crypto.randomUUID()
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch
  const api = '/__transfer-check', base = api + `/organizations/${orgId}/requests/${requestId}`
  const state = { holdCancellation: true, failCancellation: true, reserves: 0, cancellations: [] as string[] }
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
  const until = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('Transfer UI timed out')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!
  const ready = () => !host.querySelector('[aria-busy="true"]')
  try {
    await createLocalDevice(userId, crypto.randomUUID())
    const recipient = await createLocalDevice(recipientId, crypto.randomUUID())
    const peer = await deviceIdentity(recipientId, recipient.deviceId, recipient.keys.publicKey, recipient.signingKeys.publicKey)
    await pinPeerIdentity(userId, peer, await identityFingerprint(peer))
    window.fetch = async (input, init) => {
      const path = String(input)
      if (path === base + '/transfer') return Response.json({ organizationId: orgId, requestId, senderUserId: userId, recipientUserId: recipientId, recipientDeviceId: recipient.deviceId,
        receiver: peer, projectId: crypto.randomUUID(), environmentId: crypto.randomUUID(), sessionHash: 'public-test' })
      if (path === base + '/uploads') {
        state.reserves++
        if (rejectReservation) return Response.json({error:'storage_limit'},{status:429})
        return new Promise<Response>((_resolve, reject) => {
          const signal = init!.signal!
          if (signal.aborted) reject(signal.reason)
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      if (path.startsWith(base + '/uploads/') && path.endsWith('/cancel')) {
        state.cancellations.push(JSON.parse(init!.body as string).operationId)
        await until(() => !state.holdCancellation)
        return state.failCancellation ? Response.json({ error: 'storage_unavailable' }, { status: 503 }) : Response.json({ status: 'cancelled' })
      }
      throw new Error('Unexpected test request: ' + path)
    }
    root.render(createElement(ProTransfer, { api, orgId, requestId, userId, csrf: 'test-only', sending: true, project: 'QA', environment: 'development', onDone: async () => {}, onExpired: () => { throw new Error('Unexpected expiry') }, onNavigate: () => {} }))
    await until(() => !!button('상대 기기 확인'))
    button('상대 기기 확인').click(); await until(() => !!host.querySelector('input[type="file"]') && ready())
    const files = new DataTransfer(); files.items.add(new File(['PUBLIC_TEST=not-a-secret\n'], '.env'))
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!; input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true }))
    await until(() => !button('암호화해서 업로드').disabled)
    if (rejectReservation) {
      button('암호화해서 업로드').click(); await until(() => state.reserves === 1 && ready())
      check(!input.disabled && !button('업로드 시도 취소'), 'Rejected team reservation must unlock originals without retaining a nonexistent upload')
      check(host.querySelector<HTMLInputElement>('input:not([type="file"])')?.value === '.env', 'Rejected reservation must preserve the source path')
      rejectReservation = false; state.reserves = 0
    }
    button('암호화해서 업로드').click(); await until(() => state.reserves === 1 && !!button('업로드 시도 취소'))
    const cancel = button('업로드 시도 취소'); cancel.click(); cancel.click(); cancel.click()
    await until(() => !!button('취소 확인 중…'))
    check(state.cancellations.length === 1 && button('취소 확인 중…').disabled, 'Rapid cancellation must send one request and disable retries while pending')
    button('같은 업로드 재시도').click(); check(state.reserves === 1, 'Upload must stay blocked while cancellation is pending')
    state.holdCancellation = false; await until(ready)
    check(!!button('업로드 시도 취소') && host.textContent?.includes('파일 저장소가 아직 준비되지 않았어요.'), 'Failed cancellation must retain the encrypted upload and explain retry')
    state.failCancellation = false; state.holdCancellation = true; button('업로드 시도 취소').click(); await until(() => !!button('취소 확인 중…'))
    state.holdCancellation = false; await until(ready)
    check(state.cancellations.length === 2 && state.cancellations[0] === state.cancellations[1], 'Cancellation retries must reuse the same operation ID')
    check(!button('업로드 시도 취소') && host.textContent?.includes('업로드 시도를 취소했어요.'), 'Confirmed cancellation must clear the pending upload')
    return { passed: true, checks: ['rapid cancel single request', 'upload blocked during cancel', 'failure preserves encrypted retry', 'idempotent cancellation retry'] }
  } finally {
    state.holdCancellation = false; root.unmount(); host.remove(); window.fetch = originalFetch
    await Promise.all([deleteLocalDevice(userId), deleteLocalDevice(recipientId)])
  }
}

export const verifyTransferReservationRecovery = () => verifyTransferCancellation(true)
