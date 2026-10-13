// Isolated Vite QA page: await (await import('/tests/environment-files.browser.tsx')).verifyEnvironmentPublishGrantReceive()
// Mocked HTTP only. The mock verifies real publisher signatures, device proofs and wrap formats.
import { createRoot } from 'react-dom/client'
import { DEVICE_CHALLENGE_MS, deviceHash, deviceIdentity, encryptDeviceChallenge, identityFingerprint, verifyDeviceProof } from '@envhandoff/protocol/device-proof'
import type { DeviceIdentity, PublicationAction, PublicationDeviceChallenge } from '@envhandoff/protocol/device-proof'
import { publicationPayloadDigest, signPublicationStatement, validatePublicationWrap, verifyPublicationStatement } from '@envhandoff/protocol/environment-files'
import type { PublicationStatement, PublicationWrapInput } from '@envhandoff/protocol/environment-files'
import { createLocalDevice, deleteLocalDevice } from '../src/lib/device-keys.ts'
import type { LocalDevice } from '../src/lib/device-keys.ts'
import { sealEnvironmentBundle, wrapEnvironmentKey } from '../src/lib/environment-keys.ts'
import type { SourceFile } from '../src/lib/bundle.ts'
import { ProEnvironment } from '../src/components/ProEnvironment.tsx'

const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
async function until(condition: () => boolean, label = 'Environment files check timed out') {
  const end = Date.now() + 8000
  do { await new Promise(resolve => setTimeout(resolve, 20)); if (condition()) return } while (Date.now() < end)
  throw new Error(label)
}
type Perms = { receive: boolean; send: boolean; externalShare: boolean }
type Version = { statement: PublicationStatement; status: string; login: string; bytes?: Uint8Array; wraps: Map<string, { recipient: DeviceIdentity; wrapper: DeviceIdentity; wrap: string }> }

function mockServer(orgId: string, projectId: string, environmentId: string) {
  const api = '/__environment-files-qa', root = `${api}/organizations/${orgId}/environments/${environmentId}/files`
  const users = new Map<string, { login: string; perms: Perms }>(), devices = new Map<string, DeviceIdentity>()
  const versions = new Map<string, Version>(), challenges = new Map<string, { challenge: PublicationDeviceChallenge; secretHash: string }>()
  const cancellations = new Set<string>()
  const head = { generation: crypto.randomUUID(), versionId: null as string | null }
  const log: string[] = []
  const server = { api, root, users, devices, versions, head, log, user: '', sessionHash: '', conflictNext: null as null | (() => Promise<void>), afterCommit: null as null | (() => Promise<void>), failReservation: false }
  const fail = (error: string, status = 400) => Response.json({ error }, { status })
  const identityOf = (deviceId: string, userId = server.user) => { const d = devices.get(deviceId); return d && d.userId === userId ? d : undefined }
  const view = (version: Version) => ({ ...version.statement, status: version.status, createdAt: 1, publishedAt: version.status === 'committed' ? 2 : null, endedAt: null, endReason: null, publisherLogin: version.login, publisherActive: true })
  async function consume(body: { id: string; proof: string }, action: PublicationAction, payloadDigest?: string) {
    const entry = challenges.get(body.id); challenges.delete(body.id)
    if (!entry || entry.challenge.action !== action || (payloadDigest && entry.challenge.scope.payloadDigest !== payloadDigest) || !await verifyDeviceProof(entry.challenge, body.proof, entry.secretHash)) throw new Error('invalid_proof')
    return entry.challenge
  }
  async function handle(path: string, method: string, body: any): Promise<Response> {
    const user = users.get(server.user)!
    if (path.startsWith(root + '?') || path === root) {
      const deviceId = new URL(path, location.origin).searchParams.get('device'), mine = deviceId ? identityOf(deviceId) : undefined
      const latest = head.versionId ? versions.get(head.versionId)! : null, wrap = latest && mine ? latest.wraps.get(mine.deviceId) : undefined
      const grantor = user.perms.send && user.perms.receive
      return Response.json({ sessionHash: server.sessionHash, permissions: user.perms, generation: head.generation, endReason: null, latest: latest && view(latest),
        access: !latest ? 'empty' : !mine ? 'no_device' : wrap ? 'available' : 'needs_grant', wrap: wrap ? { ...wrap, wrapperActive: true } : null,
        recipients: grantor ? [...devices.values()].filter(d => users.get(d.userId)?.perms.receive).map(d => ({ identity: d, login: users.get(d.userId)!.login, hasWrap: !!latest?.wraps.has(d.deviceId) })) : [] })
    }
    check(method === 'POST' || /\/versions\/[^/]+$/.test(path), 'Unexpected GET ' + path)
    const match = /\/versions(?:\/([^/]+)(?:\/(\w+))?)?$/.exec(path)!, [, id, action] = match
    if (!id) {
      log.push('reserve')
      if (server.failReservation) { server.failReservation = false; throw new TypeError('Synthetic reservation connection loss') }
      if (cancellations.has(body.operationId)) return Response.json({ versionId: body.operationId, status: 'cancelled' })
      const prior = versions.get(body.operationId)
      if (prior) return Response.json(view(prior))
      if (server.conflictNext) { const run = server.conflictNext; server.conflictNext = null; await run() }
      const publisher = identityOf(body.deviceId)!
      if (body.expectedGeneration !== head.generation) return fail('version_conflict', 409)
      const statement: PublicationStatement = { organizationId: orgId, projectId, environmentId, versionId: body.operationId, expectedGeneration: body.expectedGeneration, size: body.size, digest: body.digest, publisher, signature: body.signature }
      check(await verifyPublicationStatement(statement), 'Reservation signature must verify')
      check(body.wraps.some((w: PublicationWrapInput) => w.recipientDeviceId === publisher.deviceId), 'Self wrap is required')
      const wraps = new Map<string, { recipient: DeviceIdentity; wrapper: DeviceIdentity; wrap: string }>()
      for (const w of body.wraps as PublicationWrapInput[]) wraps.set(w.recipientDeviceId, { recipient: devices.get(w.recipientDeviceId)!, wrapper: publisher, wrap: validatePublicationWrap(w.wrap) })
      versions.set(body.operationId, { statement, status: 'reserved', login: user.login, wraps })
      return Response.json(view(versions.get(body.operationId)!))
    }
    const version = versions.get(id)
    if (!version && action === 'cancel') { cancellations.add(id); log.push('cancel'); return Response.json({ versionId: id, status: 'cancelled' }) }
    if (!version) return fail('publication_unavailable', 404)
    if (!action) return Response.json({ version: view(version), generation: head.generation, isLatest: head.versionId === id })
    const actor = identityOf(body.deviceId)
    if (action === 'challenge') {
      const target = body.action === 'publication-grant' ? devices.get(body.targetDeviceId)! : actor!
      if (body.action === 'publication-upload') check(body.payloadDigest === await publicationPayloadDigest('publication-upload', { signature: version.statement.signature, wraps: [...version.wraps].map(([recipientDeviceId, w]) => ({ recipientDeviceId, wrap: w.wrap })) }), 'Upload payload digest must match the reservation')
      const issuedAt = Date.now()
      const challenge: PublicationDeviceChallenge = { id: crypto.randomUUID(), action: body.action, sessionHash: server.sessionHash, actor: actor!, target, issuedAt, expiresAt: issuedAt + DEVICE_CHALLENGE_MS,
        scope: { organizationId: orgId, projectId, environmentId, versionId: id, generation: body.action === 'publication-upload' ? version.statement.expectedGeneration : head.generation, digest: version.statement.digest, targetDeviceId: target.deviceId, payloadDigest: body.payloadDigest } }
      const { wire, secretHash } = await encryptDeviceChallenge(challenge)
      challenges.set(challenge.id, { challenge, secretHash })
      return Response.json(wire)
    }
    if (action === 'download') {
      log.push('download')
      await consume(body, 'publication-download', await publicationPayloadDigest('publication-download'))
      if (head.versionId !== id || !version.wraps.has(actor!.deviceId) || !user.perms.receive) return fail('publication_unavailable', 404)
      return new Response(version.bytes!.slice(), { headers: { 'content-type': 'application/octet-stream' } })
    }
    if (action === 'grants') {
      log.push('grant')
      const challenge = await consume(body, 'publication-grant', await publicationPayloadDigest('publication-grant', { targetDeviceId: body.targetDeviceId, wrap: body.wrap }))
      check(challenge.target.deviceId === body.targetDeviceId && version.wraps.has(actor!.deviceId) && !version.wraps.has(body.targetDeviceId), 'Grant must come from a wrapped grantor to an unwrapped target')
      version.wraps.set(body.targetDeviceId, { recipient: challenge.target, wrapper: actor!, wrap: validatePublicationWrap(body.wrap) })
      return Response.json({ ok: true })
    }
    if (action === 'remove') {
      log.push('remove')
      await consume(body, 'publication-remove', await publicationPayloadDigest('publication-remove'))
      if (body.expectedGeneration !== head.generation) return fail('version_conflict', 409)
      head.versionId = null; head.generation = crypto.randomUUID()
      return Response.json({ generation: head.generation })
    }
    if (action === 'cancel') { log.push('cancel'); if (version.status !== 'committed') version.status = 'cancelled'; return Response.json(view(version)) }
    throw new Error('Unexpected request ' + path)
  }
  async function content(url: string, headers: Record<string, string>, bytes: Uint8Array) {
    const id = /\/versions\/([^/]+)\/content$/.exec(url)![1], version = versions.get(id)!
    log.push('content')
    const challenge = await consume({ id: headers['x-device-challenge'], proof: headers['x-device-proof'] }, 'publication-upload')
    check(headers['x-csrf-token'] === 'qa-csrf' && challenge.scope.versionId === id, 'Content upload must carry CSRF and a scoped proof')
    check(bytes.byteLength === version.statement.size && await deviceHash(bytes) === version.statement.digest, 'Uploaded bytes must match the signed statement')
    if (head.generation !== version.statement.expectedGeneration) { version.status = 'failed'; return 409 }
    version.bytes = bytes; version.status = 'committed'; head.versionId = id; head.generation = crypto.randomUUID()
    if (server.afterCommit) { const run = server.afterCommit; server.afterCommit = null; await run() }
    return 200
  }
  // Test-only direct publication by another device, for conflict scenarios.
  async function publishAs(local: LocalDevice, identity: DeviceIdentity, files: SourceFile[], recipients: DeviceIdentity[], keys: Map<string, CryptoKey>) {
    const sealed = await sealEnvironmentBundle(files, 'QA', 'development'), versionId = crypto.randomUUID()
    const statement = await signPublicationStatement({ organizationId: orgId, projectId, environmentId, versionId, expectedGeneration: head.generation, size: sealed.size, digest: sealed.digest, publisher: identity }, local.signingKeys.privateKey)
    const wraps = new Map<string, { recipient: DeviceIdentity; wrapper: DeviceIdentity; wrap: string }>()
    for (const recipient of [identity, ...recipients]) wraps.set(recipient.deviceId, { recipient, wrapper: identity, wrap: await wrapEnvironmentKey(sealed.code, statement, identity, local.keys, recipient, keys.get(recipient.deviceId)!) })
    versions.set(versionId, { statement, status: 'committed', login: users.get(identity.userId)!.login, bytes: new Uint8Array(sealed.bytes), wraps })
    head.versionId = versionId; head.generation = crypto.randomUUID()
  }
  return { ...server, get state() { return server }, handle, content, publishAs }
}

async function setup() {
  const orgId = crypto.randomUUID(), projectId = crypto.randomUUID(), environmentId = crypto.randomUUID()
  const server = mockServer(orgId, projectId, environmentId)
  server.state.sessionHash = await deviceHash('qa-session')
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), originalFetch = window.fetch, originalXhr = window.XMLHttpRequest
  const originalObjectUrl = URL.createObjectURL, originalClick = HTMLAnchorElement.prototype.click
  const downloads: { name: string; blob: Blob }[] = [], shared: { files: SourceFile[]; environmentId: string }[] = []
  let lastBlob: Blob | undefined
  URL.createObjectURL = (blob: Blob | MediaSource) => { lastBlob = blob as Blob; return originalObjectUrl(blob) }
  HTMLAnchorElement.prototype.click = function () { if (this.download) downloads.push({ name: this.download, blob: lastBlob! }); else originalClick.call(this) }
  window.fetch = async (input, init) => {
    const path = String(input)
    if (!path.startsWith(server.api)) return originalFetch(input, init)
    if (init?.method === 'POST') check(new Headers(init.headers).get('x-csrf-token') === 'qa-csrf', 'Writes require CSRF')
    try { return await server.handle(path, init?.method ?? 'GET', init?.body ? JSON.parse(init.body as string) : undefined) }
    catch (error) { if (error instanceof Error && error.message === 'invalid_proof') return Response.json({ error: 'invalid_proof' }, { status: 403 }); throw error }
  }
  class MockUpload {
    upload = { onprogress: (_event: { lengthComputable: boolean; loaded: number; total: number }) => {} }
    status = 0; responseText = '{}'; withCredentials = false; timeout = 0; url = ''; headers: Record<string, string> = {}
    onload = () => {}; onloadend = () => {}; onabort = () => {}; onerror = () => {}; ontimeout = () => {}
    open(_method: string, url: string) { this.url = url }
    setRequestHeader(name: string, value: string) { this.headers[name] = value }
    getResponseHeader() { return null }
    send(bytes: ArrayBuffer) { void server.content(this.url, this.headers, new Uint8Array(bytes)).then(status => { this.status = status; this.upload.onprogress({ lengthComputable: true, loaded: bytes.byteLength, total: bytes.byteLength }); this.onload(); this.onloadend() }, () => { this.onerror(); this.onloadend() }) }
    abort() { this.onabort(); this.onloadend() }
  }
  window.XMLHttpRequest = MockUpload as unknown as typeof XMLHttpRequest
  const ids: string[] = []
  async function person(login: string, perms: Perms, withDevice = true) {
    const userId = crypto.randomUUID(); ids.push(userId)
    server.users.set(userId, { login, perms })
    if (!withDevice) return { userId, local: undefined as unknown as LocalDevice, identity: undefined as unknown as DeviceIdentity, fingerprint: '' }
    const local = await createLocalDevice(userId, crypto.randomUUID())
    const identity = await deviceIdentity(userId, local.deviceId, local.keys.publicKey, local.signingKeys.publicKey)
    server.devices.set(identity.deviceId, identity)
    return { userId, local, identity, fingerprint: await identityFingerprint(identity) }
  }
  function render(userId: string, acceptNewTransfers = true) {
    server.state.user = userId
    root.render(<ProEnvironment key={userId + String(Date.now())} api={server.api} orgId={orgId} projectId={projectId} environmentId={environmentId} project="QA" environment="development" userId={userId} csrf="qa-csrf"
      acceptNewTransfers={acceptNewTransfers} disabled={false} onExpired={() => { throw new Error('Unexpected expiry') }} onNavigate={() => {}} onExternalShare={(files, env) => shared.push({ files, environmentId: env })} />)
  }
  const text = () => container.textContent ?? ''
  const idle = () => !!container.querySelector('section[aria-busy="false"]')
  const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  const click = (label: string) => { const node = button(label); check(node && !node.disabled, `Button ${label} must be enabled`); node!.click() }
  const type = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const choose = (files: File[]) => {
    // Enter the visible editing flow before selecting files; the editor starts collapsed.
    const editor = container.querySelector<HTMLDetailsElement>('details.pro-editor')!
    if (!editor.open) editor.querySelector('summary')!.click()
    const data = new DataTransfer(); files.forEach(file => data.items.add(file))
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!; input.files = data.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const pathInputs = () => [...container.querySelectorAll<HTMLInputElement>('.pro-env-op input')]
  async function cleanup() {
    root.unmount(); container.remove()
    window.fetch = originalFetch; window.XMLHttpRequest = originalXhr; URL.createObjectURL = originalObjectUrl; HTMLAnchorElement.prototype.click = originalClick
    await Promise.all(ids.map(id => deleteLocalDevice(id)))
  }
  return { server, container, render, text, idle, button, click, type, choose, pathInputs, person, downloads, shared, cleanup, orgId, projectId, environmentId }
}

export async function verifyEnvironmentPublishGrantReceive() {
  const t = await setup()
  try {
    const owner = await t.person('qa-owner', { receive: true, send: true, externalShare: true })
    const member = await t.person('qa-member', { receive: true, send: false, externalShare: true })
    t.render(owner.userId)
    await until(() => t.idle() && !!t.container.querySelector('input[type="file"]'), 'Empty head should allow a first publish')
    t.choose([new File(['PUBLIC_TEST=one\r\n'], '.env'), new File([new Uint8Array([0, 255, 128])], 'app.env')])
    await until(() => t.pathInputs().length === 2)
    check(t.text().includes('새 파일 · 저장소 루트/.env'), 'Destination path must be shown on selection')
    t.type(t.pathInputs()[1], '../app.env')
    await until(() => !!t.container.querySelector('[role="alert"]'))
    check(t.button('팀에 게시')!.disabled, 'Unsafe paths must block publishing')
    t.type(t.pathInputs()[1], 'config/app.env')
    await until(() => !t.container.querySelector('[role="alert"]') && t.text().includes('config/app.env · 새 파일'))
    check(t.text().includes('1개 기기는 이 게시본에 접근하지 못해요'), 'Unpinned recipients must be counted before publishing')
    t.click('팀에 게시'); t.button('팀에 게시')?.click()
    await until(() => t.idle() && t.text().includes('팀에 게시했어요'))
    const first = t.server.versions.get(t.server.head.versionId!)!
    check(t.server.log.filter(entry => entry === 'reserve').length === 1, 'Duplicate clicks must reserve once')
    check(first.wraps.size === 1 && first.wraps.has(owner.identity.deviceId), 'Only the self wrap is included without explicit trust')
    check(!t.button(`qa-member에게 접근 제공`) && t.text().includes('지문 확인 필요'), 'Unpinned devices must not be offered a grant')

    // Reload: a new mount starts with nothing in memory and must download, verify and decrypt.
    t.render(owner.userId)
    await until(() => t.idle() && !!t.button('최신 파일 열기'))
    check(!t.text().includes('config/app.env'), 'File names stay hidden until the bundle is opened')
    t.click('최신 파일 열기')
    await until(() => t.idle() && t.text().includes('config/app.env') && t.text().includes('이 기기에서 게시했어요'))
    ;[...t.container.querySelectorAll<HTMLButtonElement>('.pro-env-files button')].find(node => node.textContent === '다운로드')!.click()
    await until(() => t.downloads.length === 1)
    check(t.downloads[0].name === '.env' && await t.downloads[0].blob.text() === 'PUBLIC_TEST=one\r\n', 'Download must return original bytes')

    // Explicit fingerprint confirmation before granting the member's device.
    const access = t.container.querySelector<HTMLDetailsElement>('details.pro-access-section')!
    check(!access.open, 'Recipient management starts collapsed so file actions stay primary')
    access.querySelector('summary')!.click()
    await until(() => access.open)
    const form = t.container.querySelector<HTMLFormElement>('form[aria-label="qa-member 지문 확인"]')!
    t.type(form.querySelector('input')!, 'wrong-fingerprint'); form.requestSubmit()
    await until(() => t.idle() && !!t.container.querySelector('[role="alert"]'))
    check(!t.button('qa-member에게 접근 제공'), 'Mismatched fingerprint must not trust the device')
    t.type(form.querySelector('input')!, member.fingerprint); form.requestSubmit()
    await until(() => t.idle() && !!t.button('qa-member에게 접근 제공'))
    t.click('qa-member에게 접근 제공')
    await until(() => t.idle() && t.text().includes('qa-member의 기기에 파일 접근을 제공했어요'))
    check(first.wraps.get(member.identity.deviceId)?.wrapper.deviceId === owner.identity.deviceId, 'Grant must be wrapped by the owner device')

    // Member: wrapper trust is explicit, then files open; no publish UI without send.
    t.render(member.userId)
    await until(() => t.idle() && !!t.container.querySelector('form[aria-label="접근을 제공한 기기 지문 확인"]'))
    check(t.button('최신 파일 열기')!.disabled && !t.container.querySelector('input[type="file"]'), 'Wrapper must be pinned before opening; receive-only has no publisher UI')
    const wrapper = t.container.querySelector<HTMLFormElement>('form[aria-label="접근을 제공한 기기 지문 확인"]')!
    t.type(wrapper.querySelector('input')!, owner.fingerprint); wrapper.requestSubmit()
    await until(() => t.idle() && !t.button('최신 파일 열기')!.disabled)
    t.click('최신 파일 열기')
    await until(() => t.idle() && t.text().includes('config/app.env') && t.text().includes('지문을 확인한 기기의 서명을 확인했어요'))

    // Individual external share passes exactly one file; multiple files require explicit selection.
    const row = [...t.container.querySelectorAll('.pro-env-files li')].find(node => node.textContent?.includes('config/app.env'))!
    ;[...row.querySelectorAll('button')].find(node => node.textContent === '이 파일 외부 공유')!.click()
    check(t.shared.length === 1 && t.shared[0].files.length === 1 && t.shared[0].files[0].path === 'config/app.env' && t.shared[0].environmentId === t.environmentId, 'Single-file external share')
    check(new Uint8Array(await t.shared[0].files[0].file.arrayBuffer()).join() === '0,255,128', 'External share gets original bytes')
    check(!t.button('선택한 2개 외부 공유'), 'Multi-file share is opt-in')
    t.container.querySelectorAll<HTMLInputElement>('.pro-env-files input[type="checkbox"]').forEach(box => box.click())
    await until(() => !!t.button('선택한 2개 외부 공유'))
    t.click('선택한 2개 외부 공유')
    check(t.shared[1].files.map(file => file.path).sort().join() === '.env,config/app.env', 'Selected files share')

    // Paused intake: downloads remain, new publish/grant/external actions are blocked.
    t.render(member.userId, false)
    await until(() => t.idle() && !!t.button('최신 파일 열기'))
    t.click('최신 파일 열기')
    await until(() => t.idle() && t.text().includes('config/app.env'))
    check(t.button('이 파일 외부 공유')!.disabled && t.text().includes('이미 게시된 파일은 계속 받을 수 있어요'), 'Pause blocks external share but keeps downloads')
    t.render(owner.userId, false)
    await until(() => t.idle() && !!t.button('최신 파일 열기'))
    t.click('최신 파일 열기')
    await until(() => t.idle() && t.text().includes('config/app.env'))
    t.choose([new File(['X=1'], 'new.env')])
    await until(() => t.pathInputs().length === 1)
    check(t.button('팀에 게시')!.disabled, 'Pause blocks publishing')
    return { passed: true, checks: ['first publish with root-relative paths', 'unsafe path blocked', 'duplicate click locked', 'self-only wraps', 'reload download verifies and decrypts', 'original bytes', 'explicit pin then grant', 'wrapper pin before open', 'single and selected external share', 'pause'] }
  } finally { await t.cleanup() }
}

export async function verifyEnvironmentConflictKeepsDraft() {
  const t = await setup()
  try {
    const owner = await t.person('qa-owner', { receive: true, send: true, externalShare: false })
    const other = await t.person('qa-other', { receive: true, send: true, externalShare: false })
    const keys = new Map([[owner.identity.deviceId, owner.local.keys.publicKey], [other.identity.deviceId, other.local.keys.publicKey]])
    await t.server.publishAs(other.local, other.identity, [{ path: '.env', file: new File(['A=1'], '.env') }, { path: 'keep.json', file: new File(['{}'], 'keep.json') }], [owner.identity], keys)
    t.render(owner.userId)
    await until(() => t.idle() && !!t.container.querySelector('form[aria-label="접근을 제공한 기기 지문 확인"]'))
    check(t.text().includes('qa-other') && !t.text().includes('keep.json'), 'Files stay hidden before wrapper trust')
    const pin = t.container.querySelector<HTMLFormElement>('form[aria-label="접근을 제공한 기기 지문 확인"]')!
    t.type(pin.querySelector('input')!, other.fingerprint); pin.requestSubmit()
    await until(() => t.idle() && !t.button('최신 파일 열기')!.disabled)
    t.click('최신 파일 열기')
    await until(() => t.idle() && t.text().includes('keep.json'))
    t.choose([new File(['A=mine'], '.env')])
    await until(() => t.text().includes('기존 경로 교체 · 저장소 루트/.env'))
    // Another device publishes first; the stale draft must be rejected without losing staged files.
    t.server.state.conflictNext = () => t.server.publishAs(other.local, other.identity, [{ path: '.env', file: new File(['A=theirs'], '.env') }, { path: 'keep.json', file: new File(['{}'], 'keep.json') }, { path: 'added.txt', file: new File(['t'], 'added.txt') }], [owner.identity], keys)
    t.click('팀에 게시')
    await until(() => t.idle() && !!t.button('최신 게시본 다시 열기'))
    check(t.pathInputs().length === 1 && t.pathInputs()[0].value === '.env', 'Staged ops survive the conflict')
    check(!t.button('같은 게시 재시도') && t.button('팀에 게시')!.disabled, 'Conflict requires review before publishing')
    t.click('최신 게시본 다시 열기')
    await until(() => t.idle() && t.text().includes('다른 사람이 바꾼 파일: .env'))
    check(t.text().includes('added.txt · 유지') && t.button('팀에 게시')!.disabled, 'Upstream additions appear; still blocked until review')
    t.container.querySelector<HTMLInputElement>('.pro-check input')!.click()
    await until(() => !t.button('팀에 게시')!.disabled)
    t.click('팀에 게시')
    await until(() => t.idle() && t.text().includes('팀에 게시했어요'))
    const latest = t.server.versions.get(t.server.head.versionId!)!
    check(latest.statement.publisher.deviceId === owner.identity.deviceId && latest.wraps.has(other.identity.deviceId), 'Re-publish wraps the pinned peer explicitly')

    // Clearing the last files uses the remove endpoint and rotates the head token.
    const before = t.server.head.generation
    for (const node of [...t.container.querySelectorAll<HTMLButtonElement>('.pro-env-files button')].filter(node => node.textContent === '삭제 항목에 추가')) node.click()
    await until(() => !!t.button('모든 파일 비우기'))
    t.click('모든 파일 비우기')
    await until(() => !!t.button('비우기 확인'))
    t.click('비우기 확인')
    await until(() => t.idle() && t.text().includes('모두 비웠어요'))
    check(!t.server.head.versionId && t.server.head.generation !== before && t.server.log.includes('remove'), 'Remove empties the head with a new generation')
    check(t.text().includes(accessEmpty), 'Empty head state is shown')
    return { passed: true, checks: ['wrapper pin before open', 'replace label on existing path', 'CAS conflict keeps staged ops', 'explicit review after reopen', 'upstream additions preserved', 'remove endpoint clears last files'] }
  } finally { await t.cleanup() }
}
const accessEmpty = '아직 게시된 파일이 없어요'

export async function verifyEnvironmentSettledPublishRecovery() {
  for (const ended of ['replaced', 'removed'] as const) {
    const t = await setup()
    try {
      const owner = await t.person('qa-owner', { receive: true, send: true, externalShare: false })
      const other = await t.person('qa-other', { receive: true, send: true, externalShare: false })
      const keys = new Map([[owner.identity.deviceId, owner.local.keys.publicKey], [other.identity.deviceId, other.local.keys.publicKey]])
      t.render(owner.userId)
      await until(() => t.idle() && !!t.container.querySelector('input[type="file"]'))
      t.choose([new File(['A=mine'], '.env')])
      await until(() => t.pathInputs().length === 1)
      let completedId = ''
      t.server.state.afterCommit = async () => {
        completedId = t.server.head.versionId!
        if (ended === 'replaced') await t.server.publishAs(other.local, other.identity, [{ path: '.env', file: new File(['A=theirs'], '.env') }, { path: 'keep.json', file: new File(['{}'], 'keep.json') }], [owner.identity], keys)
        else { t.server.head.versionId = null; t.server.head.generation = crypto.randomUUID() }
        throw new TypeError('Synthetic lost committed response')
      }
      t.click('팀에 게시')
      await until(() => t.idle() && !!t.button('결과 확인') && !!t.container.querySelector('[role="alert"]'))
      check(t.server.versions.get(completedId)?.status === 'committed', 'The uncertain attempt really committed before the head changed')
      t.click('결과 확인')
      await until(() => t.idle() && t.text().includes('게시 시도는 완료됐지만'))
      check(!t.button('결과 확인') && !t.button('같은 게시 재시도') && t.pathInputs()[0].value === '.env' && !t.pathInputs()[0].disabled, 'A superseded success settles pending and preserves editable staged files')
      check(t.button('팀에 게시')!.disabled, 'Settled success must require a fresh review before another publish')
      if (ended === 'replaced') {
        const pin = t.container.querySelector<HTMLFormElement>('form[aria-label="접근을 제공한 기기 지문 확인"]')!
        t.type(pin.querySelector('input')!, other.fingerprint); pin.requestSubmit()
        await until(() => t.idle() && !t.button('최신 파일 열기')!.disabled)
        t.click('최신 게시본 다시 열기')
      } else t.click('최신 상태 다시 확인')
      await until(() => t.idle() && !!t.container.querySelector('.pro-check input'))
      t.container.querySelector<HTMLInputElement>('.pro-check input')!.click()
      await until(() => !t.button('팀에 게시')!.disabled)
      t.click('팀에 게시')
      await until(() => t.idle() && t.text().includes('팀에 게시했어요'))
      check(t.server.head.versionId !== completedId && t.server.versions.get(t.server.head.versionId!)!.statement.publisher.deviceId === owner.identity.deviceId, 'Rebased publish gets a new immutable version')
      if (ended === 'replaced') check(t.text().includes('keep.json'), 'Rebase preserves the other publication untouched file')
    } finally { await t.cleanup() }
  }
  // A head can become empty between displaying the reopen button and clicking it.
  const t = await setup()
  try {
    const owner = await t.person('qa-owner', { receive: true, send: true, externalShare: false })
    const keys = new Map([[owner.identity.deviceId, owner.local.keys.publicKey]])
    await t.server.publishAs(owner.local, owner.identity, [{ path: '.env', file: new File(['A=base'], '.env') }], [], keys)
    t.render(owner.userId)
    await until(() => t.idle() && !!t.button('최신 파일 열기'))
    t.click('최신 파일 열기'); await until(() => t.idle() && t.text().includes('.env'))
    t.choose([new File(['A=mine'], '.env')]); await until(() => t.pathInputs().length === 1)
    await t.server.publishAs(owner.local, owner.identity, [{ path: '.env', file: new File(['A=next'], '.env') }], [], keys)
    t.click('상태 새로고침'); await until(() => t.idle() && !!t.button('최신 게시본 다시 열기'))
    check(!t.container.querySelector('.pro-env-files') && !t.button('다운로드') && t.pathInputs()[0].value === '.env', 'New head metadata must hide old download/share bytes while keeping staged edits')
    t.server.head.versionId = null; t.server.head.generation = crypto.randomUUID()
    t.click('최신 게시본 다시 열기')
    await until(() => t.idle() && !!t.container.querySelector('.pro-check input'))
    t.container.querySelector<HTMLInputElement>('.pro-check input')!.click()
    await until(() => !t.button('팀에 게시')!.disabled)
    t.click('팀에 게시'); await until(() => t.idle() && t.text().includes('팀에 게시했어요'))
    return { passed: true, checks: ['lost successful response then superseded', 'lost successful response then removed', 'terminal result unlocks staged files', 'explicit latest review with new immutable version', 'upstream untouched bytes retained', 'empty head during reopen rebases generation'] }
  } finally { await t.cleanup() }
}

export async function verifyEnvironmentCancelAbsentReservation() {
  const t = await setup()
  try {
    const owner = await t.person('qa-owner', { receive: true, send: true, externalShare: false })
    t.render(owner.userId)
    await until(() => t.idle() && !!t.container.querySelector('input[type="file"]'))
    t.choose([new File(['A=mine'], '.env')]); await until(() => t.pathInputs().length === 1)
    t.server.state.failReservation = true
    t.click('팀에 게시')
    await until(() => t.idle() && !!t.button('결과 확인'))
    check(t.server.versions.size === 0, 'A lost reservation request may create no server version')
    t.click('게시 중단 — 변경 작업 유지')
    await until(() => t.idle() && t.text().includes('이전 게시 시도는 종료됐어요'))
    check(!t.button('결과 확인') && !t.pathInputs()[0].disabled && t.pathInputs()[0].value === '.env', 'The cancellation fence directly settles the absent reservation without losing the draft')
    t.click('팀에 게시'); await until(() => t.idle() && t.text().includes('팀에 게시했어요'))
    check(t.server.versions.size === 1 && t.server.log.filter(action => action === 'reserve').length === 2, 'A new operation can publish after an absent reservation is cancelled')
    return { passed: true, checks: ['reservation connection loss before creation', 'cancel fence settles without status GET', 'draft remains editable', 'new operation publishes'] }
  } finally { await t.cleanup() }
}

export async function verifyEnvironmentAccessStates() {
  const t = await setup()
  try {
    const owner = await t.person('qa-owner', { receive: true, send: true, externalShare: false })
    const newcomer = await t.person('qa-new', { receive: true, send: true, externalShare: false })
    const nodevice = await t.person('qa-nodevice', { receive: true, send: false, externalShare: false }, false)
    const keys = new Map([[owner.identity.deviceId, owner.local.keys.publicKey]])
    await t.server.publishAs(owner.local, owner.identity, [{ path: '.env', file: new File(['A=1'], '.env') }], [], keys)
    t.render(nodevice.userId)
    await until(() => t.idle() && t.text().includes('이 브라우저 기기를 등록하고 승인받은 뒤'))
    check(!t.button('최신 파일 열기') && !!t.container.querySelector('a.text-button'), 'No device shows registration guidance')
    t.render(newcomer.userId)
    await until(() => t.idle() && t.text().includes('이 기기용 키 접근이 아직 없어요'))
    check([...t.container.querySelectorAll<HTMLInputElement>('input[readonly]')].some(node => node.value === newcomer.fingerprint), 'Own fingerprint is offered for access requests')
    check(!t.button('최신 파일 열기') && !t.container.querySelector('input[type="file"]') && !t.button('qa-owner에게 접근 제공'), 'Without a wrap there is no file list, editing or grant (grantor needs own wrap)')
    check(t.server.log.length === 0, 'Inspection must not mutate the server')
    return { passed: true, checks: ['no device', 'needs grant with own fingerprint', 'no automatic trust or grant without own wrap'] }
  } finally { await t.cleanup() }
}
