// Local visual review of the actual workspace components. Mutations are deliberately unsupported.
import { createRoot } from 'react-dom/client'
import { ArrowRightLeft, LogOut, Settings } from 'lucide-react'
import { deviceHash, deviceIdentity, identityFingerprint } from '@envhandoff/protocol/device-proof'
import { ProOrganizations } from '../src/components/ProOrganizations.tsx'
import { ProSecurity } from '../src/components/ProSecurity.tsx'
import { createLocalDevice, deleteLocalDevice } from '../src/lib/device-keys.ts'
import type { ProRoute } from '../src/lib/pro-navigation.ts'

export async function mountWorkspacePreview(options: { page?: ProRoute['page']; create?: boolean; reauthenticated?: boolean } = {}) {
  const api = '/__workspace-ui-preview', userId = crypto.randomUUID(), orgId = crypto.randomUUID()
  const memberId = crypto.randomUUID(), teamId = crypto.randomUUID(), projectId = crypto.randomUUID()
  const developmentId = crypto.randomUUID(), stagingId = crypto.randomUUID(), csrf = 'local-ui-preview-only'
  const local = await createLocalDevice(userId, crypto.randomUUID())
  const identity = await deviceIdentity(userId, local.deviceId, local.keys.publicKey, local.signingKeys.publicKey)
  const sessionHash = await deviceHash(crypto.randomUUID()), fingerprint = await identityFingerprint(identity)
  const now = Date.now(), day = 86_400_000
  const members = [{ id: userId, login: 'minseo-qa', role: 'owner' }, { id: memberId, login: 'jaehyun-qa', role: 'member' }]
  const organization = { id: orgId, name: 'Cobalt Studio', role: 'owner', active: 1 }
  const permissions = { receive: true, send: true, externalShare: true }
  const catalog = {
    role: 'owner', teams: [{ id: teamId, name: '워크스페이스 전체', isDefault: 1, members: [userId, memberId] }],
    projects: [{ id: projectId, name: 'cobalt-web', teamIds: [teamId],
      grants: [{ userId: memberId, receive: 1, send: 1, externalShare: 0 }],
      environments: [{ id: developmentId, name: 'development' }, { id: stagingId, name: 'staging' }].map(environment => ({
        ...environment, permissions, permissionSource: 'owner', grants: [],
      })),
    }],
  }
  const requests = [
    { id: crypto.randomUUID(), status: 'pending', direction: 'incoming', project: 'cobalt-web', environment: 'development',
      sender: 'minseo-qa', receiver: 'jaehyun-qa', receiverDeviceId: crypto.randomUUID(), createdAt: now - 12_120_000, expiresAt: now + 6 * day },
    { id: crypto.randomUUID(), status: 'approved', direction: 'outgoing', project: 'cobalt-web', environment: 'staging',
      sender: 'jaehyun-qa', receiver: 'minseo-qa', receiverDeviceId: local.deviceId, createdAt: now - 28_140_000, expiresAt: now + 5 * day },
  ]
  const shares = [
    { id: crypto.randomUUID(), status: 'available', project: 'cobalt-web', environment: 'development', environmentId: developmentId,
      createdAt: now - 4_080_000, expiresAt: now + 79_020_000, acknowledgedAt: null, canReissue: true, canRevoke: true },
    { id: crypto.randomUUID(), status: 'expired', project: 'cobalt-web', environment: 'staging', environmentId: stagingId,
      createdAt: now - 3 * day - 8_820_000, expiresAt: now - 2 * day, acknowledgedAt: now - 3 * day + 7_020_000, canReissue: false, canRevoke: false },
  ]
  const generations = new Map([developmentId, stagingId].map(id => [id, crypto.randomUUID()]))
  const security = {
    passkeys: [{ id: 'qa-mac-passkey', label: 'MacBook 패스키' }], totp: true, totpAvailable: true,
    reauthenticatedUntil: options.reauthenticated ? now + 15 * 60_000 : 0,
    sessionHash, canRegisterDevice: true, devices: [{ identity, status: 'active', fingerprint }],
    accountDeletionPublishedEnvironmentCount: 0,
  }
  const query = new URLSearchParams(location.search)
  const pages: ProRoute['page'][] = ['projects', 'requests', 'shares', 'team', 'settings', 'start', 'beta']
  const requested = query.get('page') as ProRoute['page']
  let route: ProRoute = { page: options.page ?? (pages.includes(requested) ? requested : 'projects'), orgId }
  if ((options.create ?? query.get('create') === '1') && ['requests', 'shares'].includes(route.page)) route.create = true
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch
  const unsupported = () => Response.json({ error: 'unsupported_preview_operation' }, { status: 400 })
  const previewFetch: typeof fetch = async (input, init) => {
    if (init?.signal?.aborted) throw init.signal.reason
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    // Never fall through to a production API, including unknown mock endpoints.
    if (url.origin !== location.origin || !url.pathname.startsWith(api + '/') || method !== 'GET') return unsupported()
    const path = url.pathname.slice(api.length), base = '/organizations/' + orgId
    if (path === '/organizations') return Response.json([organization])
    if (path === '/beta') return Response.json({ active: true, operator: false, owned: 1, workspaceLimit: 2 })
    if (path === '/security') return Response.json(security)
    if (path === base) return Response.json({ ...organization, members, teams: catalog.teams, invitations: [] })
    if (path === base + '/catalog') return Response.json(catalog)
    if (path === base + '/requests') return Response.json({ requests })
    if (path === base + '/requests/options') return Response.json({ senders: [{ id: memberId, login: 'jaehyun-qa' }] })
    const request = requests.find(item => path === base + '/requests/' + item.id)
    if (request) return Response.json(request)
    if (path === base + '/shares') return Response.json({ shares })
    const share = shares.find(item => path === base + '/shares/' + item.id)
    if (share) return Response.json(share)
    const environmentId = [developmentId, stagingId].find(id => path === base + '/environments/' + id + '/files')
    if (environmentId) return Response.json({ sessionHash, permissions, generation: generations.get(environmentId), endReason: null,
      latest: null, access: 'empty', wrap: null, recipients: [{ identity, login: 'minseo-qa', hasWrap: false }] })
    return unsupported()
  }
  window.fetch = previewFetch
  const navigate = (next: ProRoute) => { route = next; render(); return true }
  function render() {
    root.render(
      <main className="page-wrap pro-page pro-main">
        <section className="pro-app">
          <div className="pro-topbar">
            <div className="pro-topbar-brand"><span className="brand"><span className="brand-mark"><ArrowRightLeft aria-hidden="true" /></span>EnvHandoff</span><span className="pro-topbar-divider" aria-hidden="true">/</span><h1>팀 워크스페이스 <small className="pro-badge">Beta</small></h1></div>
            <div className="pro-account"><span className="pro-account-name">minseo-qa</span><button className="text-button" type="button" onClick={() => navigate({ page: 'settings', orgId })}><Settings aria-hidden="true" />내 설정</button><button className="text-button" type="button" disabled><LogOut aria-hidden="true" />로그아웃</button></div>
          </div>
          <ProOrganizations api={api} userId={userId} csrf={csrf} initialToken="" route={route} onNavigate={navigate}
            onResolvedOrganization={() => {}} disabled={false} acceptNewTransfers={true} onExpired={() => {}} onAccepted={() => {}}
            settings={<ProSecurity api={api} userId={userId} csrf={csrf} disabled={false} onExpired={() => {}} onDeleted={() => {}} />} />
        </section>
        <p className="pro-preview-note">로컬 UI 미리보기 · 모든 계정과 데이터는 합성이며 저장·인증·파일 전달은 실행하지 않습니다.</p>
      </main>,
    )
  }
  let disposed = false
  async function cleanup() {
    if (disposed) return
    disposed = true
    window.removeEventListener('pagehide', unload)
    root.unmount(); host.remove()
    if (window.fetch === previewFetch) window.fetch = originalFetch
    await deleteLocalDevice(userId)
  }
  const unload = () => { void cleanup() }
  window.addEventListener('pagehide', unload, { once: true })
  render()
  return { cleanup, navigate }
}
