import { createElement, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { deviceIdentity, identityFingerprint, deviceHash, encryptDeviceChallenge, DEVICE_CHALLENGE_MS } from '@envhandoff/protocol/device-proof'
import { createLocalDevice, deleteLocalDevice, pinPeerIdentity } from '../src/lib/device-keys.ts'
import { sealTeamBundle } from '../src/lib/team-crypto.ts'
import { ProTransfer } from '../src/components/ProTransfer.tsx'

const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
async function until(condition: () => boolean) {
  const end = Date.now() + 5000
  do { await new Promise(resolve => setTimeout(resolve, 20)); if (condition()) return } while (Date.now() < end)
  throw new Error('Transfer flow check timed out')
}

export async function verifyTransferTrustSteps() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch
  const userId = crypto.randomUUID(), recipientId = crypto.randomUUID(), orgId = crypto.randomUUID(), requestId = crypto.randomUUID()
  let reads = 0, posts = 0
  try {
    const local = await createLocalDevice(userId, crypto.randomUUID()), recipient = await createLocalDevice(recipientId, crypto.randomUUID())
    const peer = await deviceIdentity(recipientId, recipient.deviceId, recipient.keys.publicKey, recipient.signingKeys.publicKey)
    const fingerprint = await identityFingerprint(peer)
    window.fetch = async (_input, init) => {
      if (init?.method === 'POST') { posts++; throw new Error('Inspection must not mutate the server') }
      reads++
      return Response.json({ organizationId: orgId, requestId, senderUserId: userId, recipientUserId: recipientId, recipientDeviceId: recipient.deviceId, receiver: peer })
    }
    root.render(createElement(StrictMode, null, createElement(ProTransfer, { api: '/__trust-flow', orgId, requestId, userId, csrf: 'qa', sending: true, project: 'QA', environment: 'dev', peerLabel: 'qa-recipient', onDone: async () => {}, onExpired() {}, onNavigate() {} })))
    await until(() => reads === 2 && !!host.querySelector('form') && !host.querySelector('[aria-busy="true"]'))
    check(!host.querySelector('input[type="file"]') && posts === 0, 'Automatic inspection must not trust a new peer or send files')
    check(host.textContent?.includes('qa-recipient에게'), 'Counterpart display name should identify the task without replacing identity checks')
    const ownFingerprint = await identityFingerprint(await deviceIdentity(userId, local.deviceId, local.keys.publicKey, local.signingKeys.publicKey))
    check(host.querySelector<HTMLInputElement>('input[readonly]')?.value === ownFingerprint, 'Own device fingerprint must be available in the transfer screen')
    const input = host.querySelector<HTMLInputElement>('form input:not([readonly])')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, fingerprint)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await until(() => input.value === fingerprint)
    host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await until(() => !!host.querySelector('input[type="file"]') && !host.querySelector('[aria-busy="true"]'))
    check(reads === 2 && posts === 0, 'Explicit separate-channel confirmation should unlock preparation without another server operation')
    return { passed: true, checks: ['StrictMode safely restarts automatic fetch', 'new peer requires explicit fingerprint', 'own fingerprint available', 'display name does not establish trust'] }
  } finally { root.unmount(); host.remove(); window.fetch = originalFetch; await Promise.all([deleteLocalDevice(userId), deleteLocalDevice(recipientId)]) }
}

export async function verifyTransferAcknowledgementRetry() {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch
  const senderId = crypto.randomUUID(), userId = crypto.randomUUID(), orgId = crypto.randomUUID(), requestId = crypto.randomUUID()
  let downloads = 0, acknowledgements = 0, ackProofs = 0, done = 0, holdAck = false, releaseAck: (() => void) | undefined
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === text)
  const idle = () => !host.querySelector('[aria-busy="true"]')
  try {
    const sender = await createLocalDevice(senderId, crypto.randomUUID()), recipient = await createLocalDevice(userId, crypto.randomUUID())
    const peer = await deviceIdentity(senderId, sender.deviceId, sender.keys.publicKey, sender.signingKeys.publicKey)
    const actor = await deviceIdentity(userId, recipient.deviceId, recipient.keys.publicKey, recipient.signingKeys.publicKey)
    await pinPeerIdentity(userId, peer, await identityFingerprint(peer))
    const binding = { organizationId: orgId, projectId: crypto.randomUUID(), environmentId: crypto.randomUUID(), requestId, transferId: crypto.randomUUID(), senderUserId: senderId, senderDeviceId: sender.deviceId, recipientUserId: userId, recipientDeviceId: recipient.deviceId }
    const bytes = await sealTeamBundle([{ file: new File(['PUBLIC_FIXTURE=not-a-secret\n'], '.env'), path: 'config/.env' }], 'QA', 'dev', binding, sender.keys, recipient.keys.publicKey)
    const digest = await deviceHash(new Uint8Array(bytes)), sessionHash = await deviceHash('qa-session')
    const info = { status: 'available', binding, sender: peer, receiver: actor, size: bytes.byteLength, digest, sessionHash }
    const base = '/__ack-flow/organizations/' + orgId + '/requests/' + requestId
    window.fetch = async (input, init) => {
      const path = String(input)
      if (path === base + '/transfer') return Response.json(info)
      if (path === base + '/transfer/challenge') {
        const action = JSON.parse(init!.body as string).action as 'download' | 'ack'
        if (action === 'ack') ackProofs++
        const issuedAt = Date.now()
        return Response.json((await encryptDeviceChallenge({ id: crypto.randomUUID(), action, actor, target: actor, issuedAt, expiresAt: issuedAt + DEVICE_CHALLENGE_MS, sessionHash, scope: { organizationId: orgId, requestId, transferId: binding.transferId, digest } })).wire)
      }
      if (path === base + '/transfer/content') { downloads++; return new Response(bytes) }
      if (path === base + '/transfer/ack') {
        acknowledgements++
        if (acknowledgements === 1) return Response.json({ error: 'storage_unavailable' }, { status: 503 })
        if (holdAck) await new Promise<void>(resolve => { releaseAck = resolve })
        return Response.json({ acknowledged: true })
      }
      throw new Error('Unexpected ACK flow request ' + path)
    }
    root.render(createElement(ProTransfer, { api: '/__ack-flow', orgId, requestId, userId, csrf: 'qa', sending: false, project: 'QA', environment: 'dev', onDone: async () => { done++ }, onExpired() {}, onNavigate() {} }))
    await until(() => !!button('파일 다운로드·검사') && idle())
    button('파일 다운로드·검사')!.click()
    await until(() => acknowledgements === 1 && !!button('수신 확인 다시 보내기') && idle())
    check(host.textContent?.includes('config/.env') && downloads === 1 && done === 0, 'ACK failure must retain the decrypted file without claiming completion')
    info.status = 'revoked'; button('수신 확인 다시 보내기')!.click()
    await until(() => idle() && host.textContent?.includes('수신 확인을 남길 수 없어요.') === true)
    check(acknowledgements === 1 && ackProofs === 1 && downloads === 1, 'Retry must inspect current permission and stop before proving or ACKing a revoked transfer')
    info.status = 'available'; info.digest = await deviceHash('different-content'); button('수신 확인 다시 보내기')!.click()
    await until(() => idle() && host.textContent?.includes('수신 확인을 남길 수 없어요.') === true)
    check(acknowledgements === 1 && downloads === 1, 'Retry must not acknowledge a different digest')
    info.digest = digest; holdAck = true
    const retry = button('수신 확인 다시 보내기')!; retry.click(); retry.click(); retry.click()
    await until(() => acknowledgements === 2 && !!releaseAck)
    check(downloads === 1 && ackProofs === 2 && retry.matches(':disabled'), 'Rapid ACK retries must re-prove once without re-downloading or duplicating the report')
    releaseAck!(); await until(() => done === 1 && !button('수신 확인 다시 보내기') && idle())
    check(host.textContent?.includes('config/.env') && downloads === 1, 'Successful ACK retry must preserve the open file and notify its parent once')
    return { passed: true, checks: ['pinned peer proceeds directly', 'ACK failure preserves file', 'revoked/different transfer blocks ACK', 'retry re-proves without download', 'duplicate retries blocked'] }
  } finally { releaseAck?.(); root.unmount(); host.remove(); window.fetch = originalFetch; await Promise.all([deleteLocalDevice(senderId), deleteLocalDevice(userId)]) }
}
