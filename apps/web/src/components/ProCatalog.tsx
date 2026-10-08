import { useEffect, useId, useRef, useState } from 'react'
import { METADATA_LIMITS } from '@envhandoff/protocol'
import { limitMessage, subscribeTabReturn } from '../lib/pro-feedback.ts'
import { Notice } from './ui.tsx'
import { followProLink, proPath } from '../lib/pro-navigation.ts'
import type { ProRoute } from '../lib/pro-navigation.ts'

type Flags = { receive: boolean; send: boolean; externalShare: boolean }
type Grant = { userId: string; receive: number; send: number; externalShare: number }
type Environment = { id: string; name: string; permissions: Flags; permissionSource: 'owner' | 'project' | 'environment'; grants: Grant[] }
type Catalog = { role: 'owner' | 'member'; teams: { id: string; name: string; isDefault: number; members: string[] }[]; projects: { id: string; name: string; teamIds: string[]; grants: Grant[]; environments: Environment[] }[] }
const permissionLabels = { receive: '받기', send: '보내기', externalShare: '외부 공유' } as const
const permissionSources = { owner: 'Owner 자동 권한', project: '프로젝트 기본값', environment: '환경 예외' } as const
const grantFlags = (grant?: Grant): Flags => ({ receive: !!grant?.receive, send: !!grant?.send, externalShare: !!grant?.externalShare })
const errorMessages: Record<string, string> = {
  owner_required: 'Owner만 설정을 변경할 수 있어요. 새로고침해주세요.',
  owner_permissions_automatic: 'Owner는 모든 파일 작업 권한을 자동으로 받아요. 설정을 새로고침해주세요.',
  duplicate_name: '같은 위치에 이미 사용 중인 이름이에요.', invalid_name: '이름을 확인해주세요. 환경 이름은 1~48자, 나머지 이름은 1~80자이며 제어 문자는 사용할 수 없어요.',
  default_team_required: '기본 팀은 삭제할 수 없어요. 이름과 소속은 변경할 수 있어요.',
  organization_inactive: '워크스페이스 참여가 중지됐어요.',
  project_not_found: '프로젝트를 찾을 수 없거나 접근 권한이 없어요. 새로고침해주세요.',
  environment_not_found: '환경을 찾을 수 없어요. 새로고침해주세요.',
  member_not_found: '현재 참여 중인 멤버가 아니에요. 새로고침해주세요.',
}

function NameForm({ label, initial = '', maxLength = METADATA_LIMITS.project, save }: { label: string; initial?: string; maxLength?: number; save: (name: string) => Promise<boolean> }) {
  const id = useId()
  return <form className="pro-form" onSubmit={(event) => {
    event.preventDefault(); const form = event.currentTarget
    void save(String(new FormData(form).get('name'))).then((ok) => { if (ok && !initial) form.reset() })
  }}><div className="pro-field"><label htmlFor={id}>{label}</label><input id={id} name="name" defaultValue={initial} required maxLength={maxLength} /></div><button type="submit" className="button">{initial ? '이름 저장' : '추가'}</button></form>
}
function DeleteButton({ label, remove }: { label: string; remove: () => Promise<boolean> }) {
  const [confirming, setConfirming] = useState(false)
  return confirming ? <div className="pro-form"><p>{label} 삭제를 진행할까요? 삭제한 설정은 복구할 수 없어요.</p><div className="actions"><button type="button" className="button pro-danger" onClick={() => { void remove() }}>삭제 확인</button><button type="button" className="button" onClick={() => setConfirming(false)}>취소</button></div></div> : <button type="button" className="button pro-danger" onClick={() => setConfirming(true)}>삭제</button>
}

function PermissionForm({ login, defaults, override, environment = false, connected, save }: {
  login: string; defaults: Flags; override?: Grant; environment?: boolean; connected: boolean; save: (flags: Flags | null) => Promise<boolean>
}) {
  const [inherit, setInherit] = useState(environment && !override)
  const [flags, setFlags] = useState(override ? grantFlags(override) : defaults)
  const shown = inherit ? defaults : flags
  return <form className="pro-permission" aria-label={`${login} ${environment ? '환경 예외' : '프로젝트 기본 권한'}`} onSubmit={event => { event.preventDefault(); void save(inherit ? null : flags) }}>
    <fieldset className="plain-fieldset"><legend>{login}</legend>
      {!connected && <p className="help">이 프로젝트에 연결된 팀에 속하지 않아 현재는 파일 권한이 적용되지 않아요.</p>}
      {environment && <label className="pro-check"><input type="checkbox" checked={inherit} onChange={event => { setInherit(event.target.checked); if (!event.target.checked) setFlags(defaults) }} />프로젝트 기본값 사용</label>}
      <div className="pro-checks">{Object.entries(permissionLabels).map(([key, label]) => <label className="pro-check" key={key}><input type="checkbox" name={key} disabled={inherit} checked={shown[key as keyof Flags]} onChange={event => setFlags(current => ({ ...current, [key]: event.target.checked }))} />{label}</label>)}</div>
    </fieldset>
    <button type="submit" className="button">{login} {environment ? inherit ? '기본값 적용' : '환경 예외 저장' : '프로젝트 권한 저장'}</button>
  </form>
}

export function ProCatalog({ api, orgId, csrf, members, route, onNavigate, disabled, onExpired, onTeamsChanged }: {
  api: string; orgId: string; csrf: string; members: { id: string; login: string; role: string }[]; disabled: boolean; onExpired: () => void; onTeamsChanged: () => Promise<void>
  route: ProRoute; onNavigate: (route: ProRoute) => void
}) {
  const [data, setData] = useState<Catalog | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const connection = useRef<AbortController | null>(null)
  const mutating = useRef(false), refresh = useRef<() => Promise<void>>(async () => {})
  const expired = useRef(onExpired)
  useEffect(() => { expired.current = onExpired }, [onExpired])
  const base = api + '/organizations/' + orgId
  useEffect(() => {
    const controller = new AbortController()
    connection.current = controller
    let reading = false
    const load = async () => {
      if (reading || mutating.current || controller.signal.aborted) return
      reading = true; setBusy(true)
      try {
        const response = await fetch(base + '/catalog', { credentials: 'include', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
        if (response.status === 401) { if (!controller.signal.aborted) expired.current(); return }
        if (!response.ok) throw new Error()
        const value: Catalog = await response.json()
        if (!controller.signal.aborted) { setData(value); setError('') }
      } catch {
        if (!controller.signal.aborted) { setData(null); setError('프로젝트 정보를 불러오지 못했어요. 새로고침해주세요.') }
      } finally { reading = false; if (!controller.signal.aborted) setBusy(false) }
    }
    refresh.current = load
    void load(); const stop = subscribeTabReturn(() => { void load() })
    return () => { controller.abort(); stop() }
  }, [base, csrf])

  async function mutate(path: string, body: Record<string, unknown>, teamsChanged = false): Promise<boolean> {
    const controller = connection.current
    if (!controller || controller.signal.aborted || mutating.current) return false
    mutating.current = true
    setBusy(true); setError(''); setMessage('')
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
      const response = await fetch(base + path, { method: 'POST', credentials: 'include', signal, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify(body) })
      if (response.status === 401) { onExpired(); return false }
      const result = await response.json().catch(() => ({}))
      if (!response.ok) { if ([403,404].includes(response.status)) setData(null); setError(response.status === 429 ? limitMessage(result.error as string,response.headers.get('retry-after')) : errorMessages[result.error as string] ?? '변경하지 못했어요. 새로고침 후 다시 시도해주세요.'); return false }
      const refreshed = await fetch(base + '/catalog', { credentials: 'include', signal })
      if (!refreshed.ok) throw new Error()
      const value: Catalog = await refreshed.json()
      if (controller.signal.aborted) return false
      setData(value)
      if (teamsChanged) await onTeamsChanged()
      if (!controller.signal.aborted) setMessage('변경 사항을 저장했어요.')
      return true
    } catch { if (!controller.signal.aborted) setError('처리 결과를 확인하지 못했어요. 새로고침 후 확인해주세요.'); return false }
    finally { mutating.current = false; if (!controller.signal.aborted) setBusy(false) }
  }
  const owner = data?.role === 'owner'
  const project = route.page === 'projects' && route.id ? data?.projects.find(item => item.id === route.id) : undefined
  const multipleTeams = !!data && (data.teams.length > 1 || data.teams.some(team => !team.isDefault))
  const fileMembers = members.filter(member => member.role !== 'owner')
  const connected = (userId: string) => !!project && !!data?.teams.some(team => project.teamIds.includes(team.id) && team.members.includes(userId))
  const projectsRoute: ProRoute = {page:'projects',orgId}
  return <section className="pro-catalog pro-page" aria-busy={busy || disabled} aria-label={route.page === 'team' ? '팀 구성' : '프로젝트와 환경'}>
    {error && <Notice error>{error}</Notice>}
    <header className="pro-page-header"><div>{route.id && <a className="pro-back" href={proPath(projectsRoute)} onClick={event => followProLink(event,projectsRoute,onNavigate)}>프로젝트 목록</a>}<h2>{route.page === 'team' ? '팀 구성' : project?.name ?? (route.id ? '프로젝트 상세' : '프로젝트')}</h2><p>{route.page === 'team' ? '멤버를 팀으로 묶고 프로젝트 참여 범위를 정하세요.' : route.id ? '프로젝트 기본 권한과 환경별 예외를 확인하고 파일을 주고받으세요.' : '팀에서 공유하는 개발 환경을 한곳에서 확인하세요.'}</p></div><button type="button" className="button" disabled={busy || disabled} onClick={() => { void refresh.current() }}>설정 새로고침</button></header>
    <p className="pro-status-line" role="status">{busy ? '설정을 확인하고 있어요.' : message}</p>
    {route.page === 'projects' && <>
    <fieldset className="plain-fieldset" disabled={busy || disabled}>
      <legend className="sr-only">프로젝트와 환경</legend>
      {data?.projects.length === 0 && <div className="pro-empty-state"><h3>{owner ? '첫 프로젝트를 등록해보세요' : '아직 연결된 프로젝트가 없어요'}</h3><p>{owner ? '아래에서 프로젝트를 만든 뒤 개발·운영 환경과 파일 권한을 설정하세요.' : 'Owner에게 팀 연결을 요청해주세요.'}</p></div>}
      {!route.id && <div className="pro-project-grid">{data?.projects.map(item => <a className="pro-project-card" key={item.id} href={proPath({...projectsRoute,id:item.id})} onClick={event => followProLink(event,{...projectsRoute,id:item.id},onNavigate)}><h3>{item.name}</h3><p>환경 {item.environments.length}개</p><span>프로젝트 열기</span></a>)}</div>}
      {route.id && data && !project && <Notice error>프로젝트를 찾을 수 없거나 접근 권한이 없어요. 목록에서 다시 선택해주세요.</Notice>}
      {project && <article className="pro-project" key={project.id}>
        {owner && <details><summary>프로젝트 설정</summary>
          <NameForm key={project.name} label="프로젝트 이름" initial={project.name} save={(name) => mutate(`/projects/${project.id}/rename`, { name })} />
          {(multipleTeams || project.teamIds.length === 0) && <form className="pro-form" key={project.teamIds.join(',')} onSubmit={(event) => { event.preventDefault(); void mutate(`/projects/${project.id}/teams`, { teamIds: new FormData(event.currentTarget).getAll('team') }) }}>
            <fieldset className="plain-fieldset"><legend>프로젝트 참여 범위</legend>{data.teams.map((team) => <label className="pro-check" key={team.id}><input type="checkbox" name="team" value={team.id} defaultChecked={project.teamIds.includes(team.id)} />{multipleTeams ? team.name : '워크스페이스 멤버'}</label>)}</fieldset>
            <button className="button" type="submit">참여 범위 저장</button>
          </form>}
          <DeleteButton label={`${project.name} 프로젝트와 하위 환경·권한 설정`} remove={async () => {const ok=await mutate(`/projects/${project.id}/remove`, {});if(ok)onNavigate(projectsRoute);return ok}} />
        </details>}
        {owner && <section className="pro-panel" aria-label="프로젝트 기본 파일 권한">
          <h3>프로젝트 기본 파일 권한</h3>
          <p>Owner는 받기·보내기·외부 공유를 모두 사용할 수 있어요. 별도로 자기 권한을 설정할 필요가 없어요.</p>
          {!!fileMembers.length && <><p>팀원 권한은 여기서 한 번 설정하세요. 새 환경에도 적용되며, 환경에 별도 예외가 있으면 그 설정을 따라요.</p>
            {fileMembers.map(member => {
              const grant = project.grants?.find(item => item.userId === member.id)
              return <PermissionForm key={member.id + JSON.stringify(grant) + connected(member.id)} login={member.login} defaults={grantFlags(grant)} connected={connected(member.id)} save={flags => mutate(`/projects/${project.id}/permissions`, { userId: member.id, ...flags })} />
            })}</>}
        </section>}
        {project.environments.length === 0 && <div className="pro-empty-state"><h3>아직 등록된 환경이 없어요</h3><p>{owner ? '아래에서 development, staging처럼 팀에서 쓰는 환경을 추가하세요.' : 'Owner에게 환경 등록과 파일 권한을 요청해주세요.'}</p></div>}
        {project.environments.map((env) => <div className="pro-environment" key={env.id}>
          <h3>{env.name}</h3><p>내 파일 권한: {Object.entries(permissionLabels).filter(([key]) => env.permissions[key as keyof Flags]).map(([, label]) => label).join(' · ') || '모두 꺼짐'} · {permissionSources[env.permissionSource] ?? (owner ? permissionSources.owner : permissionSources.project)}</p>
          {env.name.length > METADATA_LIMITS.environment && <Notice error>이 환경 이름은 파일 전달에 사용할 수 있는 길이를 넘었어요. {owner ? '환경 설정에서 48자 이하로 바꿔주세요.' : 'Owner에게 환경 이름을 48자 이하로 바꿔달라고 요청해주세요.'}</Notice>}
          <div className="actions">{env.permissions.receive && <button className="button primary" type="button" onClick={() => onNavigate({page:'requests',orgId,create:true,environmentId:env.id})}>파일 요청</button>}{env.permissions.externalShare && <button className="button" type="button" onClick={() => onNavigate({page:'shares',orgId,create:true,environmentId:env.id})}>외부 공유 만들기</button>}</div>
          {owner && <details><summary>환경 설정·권한 예외</summary>
            <NameForm key={env.name} label="환경 이름" initial={env.name} maxLength={METADATA_LIMITS.environment} save={(name) => mutate(`/environments/${env.id}/rename`, { name })} />
            {!!fileMembers.length && <p>이 환경에서만 권한을 다르게 정할 때 기본값 사용을 해제하세요. 예외는 프로젝트 기본 권한이 바뀌어도 유지돼요.</p>}
            {fileMembers.map((member) => {
              const grant = env.grants.find((item) => item.userId === member.id)
              const defaults = grantFlags(project.grants?.find(item => item.userId === member.id))
              return <PermissionForm key={member.id + JSON.stringify([grant, defaults]) + connected(member.id)} login={member.login} defaults={defaults} override={grant} environment connected={connected(member.id)} save={flags => mutate(`/environments/${env.id}/permissions`, { userId: member.id, ...(flags ? flags : { inherit: true }) })} />
            })}
            <DeleteButton label={`${env.name} 환경과 권한 설정`} remove={() => mutate(`/environments/${env.id}/remove`, {})} />
          </details>}
        </div>)}
        {owner && <NameForm label="새 환경 이름" maxLength={METADATA_LIMITS.environment} save={(name) => mutate(`/projects/${project.id}/environments`, { name })} />}
      </article>}
      {!route.id && owner && data && <details className="pro-panel" open={data.projects.length === 0}><summary>프로젝트 추가</summary><form className="pro-form" onSubmit={(event) => {
        event.preventDefault(); const form = event.currentTarget, values = new FormData(form)
        void mutate('/projects', { name: values.get('name'), ...(data.teams.length > 1 ? { teamIds: values.getAll('team') } : {}) }).then((ok) => { if (ok) form.reset() })
      }}><div className="pro-field"><label htmlFor="new-project-name">프로젝트 이름</label><input id="new-project-name" name="name" required maxLength={80} placeholder="예: 팀 웹 서비스" /></div>
        {data.teams.length > 1 && <fieldset className="plain-fieldset"><legend>연결할 팀</legend>{data.teams.map((team) => <label className="pro-check" key={team.id}><input type="checkbox" name="team" value={team.id} defaultChecked={!!team.isDefault} />{team.name}</label>)}</fieldset>}
        <button type="submit" className="button primary">프로젝트 추가</button>
      </form></details>}
    </fieldset>
    <Notice>Owner는 모든 파일 작업을 할 수 있어요. 팀원은 프로젝트 기본 권한을 따르고, 필요한 환경에서만 예외를 설정해요. 받기·보내기·외부 공유는 각각 독립적이에요.</Notice>
    </>}
    {route.page === 'team' && data && <fieldset className="plain-fieldset pro-panel" disabled={busy || disabled}><legend>팀 구성</legend>
        {!multipleTeams && <p>현재 하나의 팀을 사용하고 있어요. {owner ? '별도 팀이 필요하면 아래에서 추가하세요.' : '팀을 나누려면 Owner에게 요청해주세요.'}</p>}
        {multipleTeams && data.teams.map((team) => <div className="pro-project" key={team.id}><h3>{team.name}</h3>
          {owner && <>
            <NameForm key={team.name} label="팀 이름" initial={team.name} save={(name) => mutate(`/teams/${team.id}/rename`, { name }, true)} />
            {members.map((member) => <form className="pro-permission" key={member.id + String(team.members.includes(member.id))} onSubmit={(event) => { event.preventDefault(); void mutate(`/teams/${team.id}/members`, { userId: member.id, included: new FormData(event.currentTarget).has('included') }, true) }}>
              <label className="pro-check"><input type="checkbox" name="included" defaultChecked={team.members.includes(member.id)} />{member.login}</label><button type="submit" className="button">{member.login} 소속 저장</button>
            </form>)}
            {!team.isDefault && <DeleteButton label={`${team.name} 팀과 프로젝트 연결`} remove={() => mutate(`/teams/${team.id}/remove`, {}, true)} />}
          </>}{!owner && <p>{team.members.map(id=>members.find(member=>member.id===id)?.login).filter(Boolean).join(' · ') || '등록된 멤버 없음'}</p>}
        </div>)}
        {owner && <details><summary>새 팀 만들기</summary><NameForm label="새 팀 이름" save={(name) => mutate('/teams', { name }, true)} /></details>}
    </fieldset>}
  </section>
}
