// Real parent/child UI, browser crypto and IndexedDB; HTTP/upload use synthetic data only.
import { createRoot } from 'react-dom/client'
import { DEVICE_CHALLENGE_MS, deviceHash, deviceIdentity, encryptDeviceChallenge, verifyDeviceProof } from '@envhandoff/protocol/device-proof'
import type { PublicationDeviceChallenge } from '@envhandoff/protocol/device-proof'
import { publicationPayloadDigest, signPublicationStatement } from '@envhandoff/protocol/environment-files'
import { ProOrganizations } from '../src/components/ProOrganizations.tsx'
import { createLocalDevice, deleteLocalDevice } from '../src/lib/device-keys.ts'
import { sealEnvironmentBundle, wrapEnvironmentKey } from '../src/lib/environment-keys.ts'
import { openBundle } from '../src/lib/bundle.ts'
import type { ProRoute } from '../src/lib/pro-navigation.ts'

const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
async function until(condition: () => boolean, label: string) {
  const end = Date.now() + 8000
  do { await new Promise(resolve => setTimeout(resolve, 20)); if (condition()) return } while (Date.now() < end)
  throw new Error(label)
}

async function setup() {
  const api = '/__published-share-flow-qa', orgId = crypto.randomUUID(), otherOrgId = crypto.randomUUID()
  const userId = crypto.randomUUID(), projectId = crypto.randomUUID(), environmentId = crypto.randomUUID()
  const selectedPath = 'apps/api/.env', otherPath = 'apps/web/.env.local'
  const selectedBytes = new Uint8Array([81, 65, 61, 255, 0, 13, 10])
  const local = await createLocalDevice(userId, crypto.randomUUID())
  const identity = await deviceIdentity(userId, local.deviceId, local.keys.publicKey, local.signingKeys.publicKey)
  const publication = await sealEnvironmentBundle([
    { path: selectedPath, file: new File([selectedBytes], '.env') },
    { path: otherPath, file: new File(['OTHER_PUBLIC_FIXTURE=true\n'], '.env.local') },
  ], 'QA codebase', 'development')
  const generation = crypto.randomUUID(), sessionHash = await deviceHash('qa-session')
  const statement = await signPublicationStatement({ organizationId: orgId, projectId, environmentId,
    versionId: crypto.randomUUID(), expectedGeneration: crypto.randomUUID(), size: publication.size,
    digest: publication.digest, publisher: identity }, local.signingKeys.privateKey)
  const wrap = await wrapEnvironmentKey(publication.code, statement, identity, local.keys, identity, local.keys.publicKey)
  const version = { ...statement, status: 'committed', createdAt: Date.now(), publishedAt: Date.now(), endedAt: null,
    endReason: null, publisherLogin: 'qa-owner', publisherActive: true }
  const permissions = { receive: true, send: true, externalShare: true }
  const teamId = crypto.randomUUID()
  const catalog = { role: 'owner', teams: [{ id: teamId, name: '기본 팀', isDefault: 1, members: [userId] }], projects: [{ id: projectId, name: 'QA codebase', teamIds: [teamId], grants: [],
    environments: [{ id: environmentId, name: 'development', permissions, permissionSource: 'owner', grants: [] }] }] }
  const organizations = [orgId, otherOrgId].map(id => ({ id, name: id === orgId ? 'QA workspace' : 'Other QA workspace', role: 'owner', active: 1 }))
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch, originalXhr = window.XMLHttpRequest
  const challenges = new Map<string, { challenge: PublicationDeviceChallenge; secretHash: string }>()
  const shares = new Map<string, { id: string; status: string; createdAt: number; expiresAt: number; project: string; environment: string; canReissue: boolean; canRevoke: boolean }>()
  const reservations: Record<string, unknown>[] = [], uploads: ArrayBuffer[] = [], navigations: ProRoute[] = []
  let csrf = 'qa-csrf', renderedUserId = userId, decline = false
  let route: ProRoute = { page: 'projects', orgId, id: projectId, environmentId }
  function render() {
    // This is the same session boundary key used by ProLogin.
    root.render(<ProOrganizations key={'organizations:' + renderedUserId + ':' + csrf} api={api} userId={renderedUserId} csrf={csrf}
      initialToken="" route={route} onNavigate={next => { navigations.push(next); if (decline) return false; route = next; render(); return true }}
      onResolvedOrganization={() => {}} settings={null} disabled={false} acceptNewTransfers={true}
      onExpired={() => { throw new Error('Unexpected session expiry') }} onAccepted={() => {}} />)
  }
  window.fetch = async (input, init) => {
    const path = String(input)
    if (!path.startsWith(api)) return originalFetch(input, init)
    const url = new URL(path, location.origin), body = init?.body ? JSON.parse(init.body as string) : undefined
    const suffix = url.pathname.slice(api.length)
    if (init?.method === 'POST') check(new Headers(init.headers).get('x-csrf-token') === csrf, 'Mutations must use the current session CSRF')
    if (suffix === '/organizations') return Response.json(organizations)
    if (suffix === '/beta') return Response.json({ active: true, operator: false, owned: 2, workspaceLimit: 2 })
    if (organizations.some(org => suffix === '/organizations/' + org.id)) return Response.json({
      ...organizations.find(org => suffix.endsWith(org.id)), teams: [{ id: teamId, name: '기본 팀' }], invitations: [], members: [{ id: renderedUserId, login: 'qa-owner', role: 'owner' }],
    })
    if (suffix.endsWith('/catalog')) return Response.json(catalog)
    const files = `/organizations/${orgId}/environments/${environmentId}/files`
    if (suffix === files) return Response.json({ sessionHash, permissions, generation, endReason: null, latest: version,
      access: 'available', wrap: { recipient: identity, wrapper: identity, wrap, wrapperActive: true },
      recipients: [{ identity, login: 'qa-owner', hasWrap: true }] })
    if (suffix === files + `/versions/${statement.versionId}/challenge`) {
      check(body.action === 'publication-download' && body.deviceId === identity.deviceId &&
        body.payloadDigest === await publicationPayloadDigest('publication-download'), 'Opening a file must prove the intended download')
      const issuedAt = Date.now()
      const challenge: PublicationDeviceChallenge = { id: crypto.randomUUID(), action: 'publication-download', sessionHash, actor: identity, target: identity,
        issuedAt, expiresAt: issuedAt + DEVICE_CHALLENGE_MS, scope: { organizationId: orgId, projectId, environmentId,
          versionId: statement.versionId, generation, digest: statement.digest, targetDeviceId: identity.deviceId, payloadDigest: body.payloadDigest } }
      const encrypted = await encryptDeviceChallenge(challenge)
      challenges.set(challenge.id, { challenge, secretHash: encrypted.secretHash })
      return Response.json(encrypted.wire)
    }
    if (suffix === files + `/versions/${statement.versionId}/download`) {
      const entry = challenges.get(body.id); challenges.delete(body.id)
      check(entry && await verifyDeviceProof(entry.challenge, body.proof, entry.secretHash), 'Download proof must verify against the actual local device')
      return new Response(publication.bytes.slice(0), { headers: { 'content-type': 'application/octet-stream' } })
    }
    const shareBase = `/organizations/${route.orgId}/shares`
    if (suffix === shareBase) {
      if (init?.method !== 'POST') return Response.json({ shares: [...shares.values()] })
      reservations.push(body)
      check(body.environmentId === environmentId && body.size > 0 && typeof body.digest === 'string' && typeof body.tokenHash === 'string', 'Share reserves ciphertext metadata for the selected environment')
      check(!JSON.stringify(body).includes(selectedPath) && !JSON.stringify(body).includes(publication.code), 'Server must never receive placement path or publication code')
      const share = { id: body.operationId, status: 'reserved', createdAt: Date.now(), expiresAt: Date.now() + 86400000,
        project: 'QA codebase', environment: 'development', canReissue: true, canRevoke: true }
      shares.set(share.id, share); return Response.json(share)
    }
    const share = [...shares.values()].find(item => suffix === shareBase + '/' + item.id)
    if (share) return Response.json(share)
    throw new Error('Unexpected published-share fixture request: ' + suffix)
  }
  class MockUpload {
    upload = { onprogress: (_event: { lengthComputable: boolean; loaded: number; total: number }) => {} }
    status = 0; responseText = '{}'; withCredentials = false; timeout = 0; url = ''; headers: Record<string, string> = {}
    onload = () => {}; onloadend = () => {}; onabort = () => {}; onerror = () => {}; ontimeout = () => {}
    open(_method: string, url: string) { this.url = url }
    setRequestHeader(name: string, value: string) { this.headers[name] = value }
    getResponseHeader() { return null }
    send(bytes: ArrayBuffer) {
      check(this.headers['x-csrf-token'] === csrf, 'Share ciphertext upload requires current CSRF')
      const id = /\/shares\/([^/]+)\/content$/.exec(this.url)?.[1], share = id && shares.get(id)
      check(share, 'Upload must target a reserved new share')
      uploads.push(bytes.slice(0)); share!.status = 'available'; this.status = 200
      queueMicrotask(() => { this.upload.onprogress({ lengthComputable: true, loaded: bytes.byteLength, total: bytes.byteLength }); this.onload(); this.onloadend() })
    }
    abort() { this.onabort(); this.onloadend() }
  }
  window.XMLHttpRequest = MockUpload as unknown as typeof XMLHttpRequest
  const idle = () => !host.querySelector('[aria-busy="true"]')
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label)
  const click = (label: string) => { const node = button(label); check(node && !node.matches(':disabled'), 'Enabled button required: ' + label); node!.click() }
  const pathInputs = () => [...host.querySelectorAll<HTMLInputElement>('.pro-shares input:not([type="file"])')].filter(input => !input.readOnly)
  const copyField = (label: string) => [...host.querySelectorAll('.copy-field')].find(field => field.querySelector('label')?.textContent === label)?.querySelector<HTMLInputElement>('input')
  async function openPublished() {
    route = { page: 'projects', orgId, id: projectId, environmentId }; render()
    await until(() => !!button('최신 파일 열기') && idle(), 'Published environment did not become ready')
    click('최신 파일 열기')
    await until(() => host.querySelectorAll('.pro-env-files li').length === 2 && idle(), 'Published files did not decrypt through the parent')
  }
  async function importFirst() {
    const first = host.querySelector('.pro-env-files li')!
    check(first.textContent?.includes(selectedPath), 'Fixture must start from the intended file')
    const share = [...first.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === '이 파일 외부 공유')!
    check(share && !share.disabled, 'Published file must expose sharing'); share.click()
    await until(() => !!host.querySelector('.pro-shares .pro-file-row input') && idle(), 'Imported share form did not become ready')
  }
  async function directCreate(nextOrg = orgId) {
    route = { page: 'shares', orgId: nextOrg, create: true, environmentId }; render()
    await until(() => !!host.querySelector('.pro-shares input[type="file"]') && idle(), 'Direct share form did not become ready')
  }
  async function cleanup() {
    root.unmount(); host.remove(); window.fetch = originalFetch; window.XMLHttpRequest = originalXhr
    await deleteLocalDevice(userId)
  }
  return { host, selectedPath, selectedBytes, publication, reservations, uploads, navigations, orgId, otherOrgId, environmentId,
    idle, button, click, pathInputs, copyField, openPublished, importFirst, directCreate, cleanup,
    navigate(next: ProRoute) { route = next; render() }, setDecline(value: boolean) { decline = value },
    changeSession(kind: 'csrf' | 'user') { if (kind === 'csrf') csrf = 'qa-new-csrf'; else renderedUserId = crypto.randomUUID(); render() } }
}

export async function verifyPublishedShareSelectionAndRecovery() {
  const ui = await setup()
  try {
    await ui.openPublished(); await ui.importFirst()
    check(ui.pathInputs().length === 1 && ui.pathInputs()[0]!.value === ui.selectedPath, 'Only the selected published file and its repository-relative path enter the share form')
    check(ui.host.textContent?.includes('선택한 파일 1개') && !ui.host.querySelector('.pro-shares input[type="file"]'), 'Imported files must be visible as already selected without requiring a second file choice')
    check(ui.host.querySelector('select')?.value === ui.environmentId, 'Share retains the source environment')
    ui.click('암호화해서 외부 공유')
    await until(() => !!ui.copyField('다른 경로로 전달할 공유 코드') && ui.idle(), 'Successful share navigation lost its local code')
    const code = ui.copyField('다른 경로로 전달할 공유 코드')!.value
    const link = ui.copyField('상대에게 전달할 접근 링크')!.value
    check(code !== ui.publication.code && !link.includes(code) && !link.includes(ui.publication.code), 'External sharing creates a fresh code and keeps it separate from the access link')
    check(ui.reservations.length === 1 && ui.uploads.length === 1, 'One selected-file sharing operation reserves and uploads once')
    const opened = await openBundle(ui.uploads[0]!, code)
    check(opened.files.length === 1 && opened.files[0]!.path === ui.selectedPath, 'External ciphertext contains only the selected file and original placement path')
    check(opened.files[0]!.bytes.every((byte, index) => byte === ui.selectedBytes[index]) && opened.files[0]!.bytes.byteLength === ui.selectedBytes.length, 'Sharing preserves original binary bytes')
    let reused = false
    try { await openBundle(ui.uploads[0]!, ui.publication.code); reused = true } catch { /* Expected: independent key. */ }
    check(!reused, 'Publication code must not decrypt the external share')
    ui.click('새로고침')
    await until(() => ui.idle() && ui.copyField('다른 경로로 전달할 공유 코드')?.value === code, 'Same-tab detail refresh discarded recovery code')
    check(ui.copyField('상대에게 전달할 접근 링크')?.value === link, 'Same-tab detail refresh preserves access token')
    ui.navigate({ page: 'projects', orgId: ui.orgId })
    await until(() => !ui.host.querySelector('.pro-shares'), 'Leaving sharing did not unmount secret state')
    check(!ui.host.textContent?.includes(code) && !ui.host.querySelector<HTMLInputElement>(`input[value="${code}"]`), 'Leaving sharing clears visible local code')
    await ui.directCreate()
    check(ui.pathInputs().length === 0 && ui.button('암호화해서 외부 공유')?.disabled, 'A later direct-share draft does not inherit published file bytes')
    check(!JSON.stringify(localStorage).includes(ui.selectedPath) && !JSON.stringify(sessionStorage).includes(code), 'Share bridge does not persist plaintext paths or codes')
    return { passed: true, checks: ['real parent publication decrypt', 'selected file and placement path only', 'fresh independently encrypted sharing code', 'original binary bytes', 'create→detail and refresh retain token/code', 'leaving sharing clears draft'] }
  } finally { await ui.cleanup() }
}

export async function verifyPublishedShareNavigationBoundaries() {
  const ui = await setup()
  try {
    await ui.openPublished(); ui.setDecline(true)
    const first = ui.host.querySelector('.pro-env-files li')!
    ;[...first.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === '이 파일 외부 공유')!.click()
    await until(() => ui.navigations.length > 0 && ui.idle(), 'Declined navigation was not attempted')
    check(!!ui.host.querySelector('.pro-environment-files') && !ui.host.querySelector('.pro-shares'), 'Declined navigation must retain the current environment')
    ui.setDecline(false); await ui.directCreate()
    check(ui.pathInputs().length === 0 && ui.reservations.length === 0, 'Declining navigation must never stage an imported file or create a share')
    await ui.openPublished(); await ui.importFirst()
    await ui.directCreate(ui.otherOrgId)
    check(ui.pathInputs().length === 0, 'Switching workspace must discard imported plaintext')
    for (const kind of ['csrf', 'user'] as const) {
      // Open with the current account, then cross the real ProLogin remount boundary.
      await ui.openPublished(); await ui.importFirst()
      ui.changeSession(kind)
      await until(() => !!ui.host.querySelector('.pro-shares input[type="file"]') && ui.idle(), 'Changed session did not reload the share form')
      check(ui.pathInputs().length === 0 && ui.button('암호화해서 외부 공유')?.disabled, 'Changing ' + kind + ' must discard imported plaintext')
    }
    return { passed: true, checks: ['declined navigation retains environment without shadow draft', 'workspace clears imported files', 'CSRF rotation clears imported files', 'account change clears imported files'] }
  } finally { await ui.cleanup() }
}

// Optional local preview of the same actual components used by the regressions.
export async function mountPublishedFilesQA() {
  const ui = await setup()
  try { await ui.openPublished() } catch (error) { await ui.cleanup(); throw error }
  const unload = () => { void ui.cleanup() }
  window.addEventListener('pagehide', unload, { once: true })
  return { cleanup: async () => { window.removeEventListener('pagehide', unload); await ui.cleanup() } }
}
