// Isolated Vite QA page: await (await import('/tests/project-permissions.browser.tsx')).verifyProjectPermissions()
import { createRoot } from 'react-dom/client'
import { ProCatalog } from '../src/components/ProCatalog.tsx'

const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000
  // Allow React to commit each user action before inspecting the next screen.
  await new Promise(resolve => setTimeout(resolve, 20))
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Permission UI check timed out')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

export async function verifyProjectPermissions() {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container), originalFetch = window.fetch
  const api = '/__permission-ui-qa', writes: { path: string; body: Record<string, unknown> }[] = []
  const member = { id: 'member', login: 'qa-member', role: 'member' }
  const grant = { userId: member.id, receive: 1, send: 1, externalShare: 0 }
  const environment = { id: 'env', name: 'production', permissions: { receive: true, send: true, externalShare: true }, permissionSource: 'owner', grants: [] as typeof grant[] }
  const project = { id: '30000000-0000-4000-8000-000000000001', name: 'QA 프로젝트', teamIds: ['team'], grants: [grant], environments: [environment] }
  const catalog = { role: 'owner', teams: [{ id: 'team', name: '기본 팀', isDefault: 1, members: [member.id] }], projects: [project] }
  const ready = () => !!container.querySelector('.pro-environment') && !container.querySelector('[aria-busy="true"]')
  const form = (suffix: string) => container.querySelector<HTMLFormElement>(`form[aria-label="qa-member ${suffix}"]`)!
  const box = (suffix: string, name: string) => form(suffix).querySelector<HTMLInputElement>(`input[name="${name}"]`)!
  const inheritance = () => form('환경 예외').querySelector<HTMLInputElement>('input:not([name])')!
  const render = () => root.render(<ProCatalog api={api} orgId="10000000-0000-4000-8000-000000000001" csrf="test-only" members={[{ id: 'owner', login: 'qa-owner', role: 'owner' }, member]} route={{ page: 'projects', orgId: '10000000-0000-4000-8000-000000000001', id: project.id }} onNavigate={() => {}} disabled={false} onExpired={() => { throw new Error('Unexpected expiry') }} onTeamsChanged={async () => {}} />)
  window.fetch = async (input, init) => {
    const path = String(input)
    if (!path.startsWith(api)) return originalFetch(input, init)
    if (path.endsWith('/catalog')) return Response.json(catalog)
    const body = JSON.parse(init?.body as string)
    writes.push({ path, body })
    check(init?.method === 'POST' && new Headers(init.headers).get('x-csrf-token') === 'test-only', 'Permission writes require POST and CSRF')
    check(body.userId === member.id, 'Owner must never be a permission write target')
    const updated = { userId: member.id, receive: Number(body.receive), send: Number(body.send), externalShare: Number(body.externalShare) }
    if (path.endsWith(`/projects/${project.id}/permissions`)) project.grants = [updated]
    else if (path.endsWith('/environments/env/permissions')) environment.grants = body.inherit ? [] : [updated]
    else throw new Error('Unexpected permission write')
    return Response.json({ ok: true })
  }
  try {
    render(); await until(ready)
    check(!container.querySelector('form[aria-label^="qa-owner"]'), 'Owner must have no personal permission forms')
    check(container.textContent?.includes('Owner 자동 권한'), 'Effective rights must identify the Owner source')
    const details = [...container.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent === '환경 설정·권한 예외')!
    details.open = true
    check(inheritance().checked && box('환경 예외', 'send').checked && box('환경 예외', 'send').disabled, 'Environment initially displays inherited rights')
    box('프로젝트 기본 권한', 'externalShare').click()
    form('프로젝트 기본 권한').requestSubmit()
    await until(() => writes.length === 1 && ready() && box('환경 예외', 'externalShare').checked)
    inheritance().click(); await until(() => !box('환경 예외', 'send').disabled)
    box('환경 예외', 'send').click(); form('환경 예외').requestSubmit()
    await until(() => writes.length === 2 && ready() && !box('환경 예외', 'send').checked)
    box('프로젝트 기본 권한', 'receive').click(); form('프로젝트 기본 권한').requestSubmit()
    await until(() => writes.length === 3 && ready())
    check(box('환경 예외', 'receive').checked && !inheritance().checked, 'Project edits must preserve explicit environment overrides')
    inheritance().click(); await until(() => box('환경 예외', 'send').disabled)
    form('환경 예외').requestSubmit()
    await until(() => writes.length === 4 && ready() && inheritance().checked)
    check(JSON.stringify(writes[3]!.body) === JSON.stringify({ userId: member.id, inherit: true }), 'Reset must send inheritance without stale flags')
    check(!box('환경 예외', 'receive').checked && box('환경 예외', 'externalShare').checked, 'Reset must display the latest project defaults')
    catalog.role = 'member'; project.grants = []; environment.permissionSource = 'project'
    ;[...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '설정 새로고침')!.click()
    await until(() => ready() && !container.querySelector('form'))
    check(container.textContent?.includes('프로젝트 기본값'), 'Member must see its permission source without management forms')
    return { passed: true, checks: ['Owner automatic rights without checkboxes', 'project permission save', 'environment inheritance', 'override survives project edits', 'reset inherits current defaults', 'Member read-only permission source'] }
  } finally { root.unmount(); window.fetch = originalFetch; container.remove() }
}
