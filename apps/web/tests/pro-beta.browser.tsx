// Isolated Vite/Chrome QA: (await import('/tests/pro-beta.browser.tsx')).verifyBetaFlow()
import { createElement, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProOrganizations } from '../src/components/ProOrganizations.tsx'
import type { ProRoute } from '../src/lib/pro-navigation.ts'

export async function mountBetaQA(operator = false, withWorkspaces = false) {
  document.querySelector<HTMLElement>('#root')!.hidden = true
  const host = document.createElement('div'); host.className = 'page-wrap pro-page'; document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch
  const state = { active: operator, operator, owned: 0, workspaceLimit: 2 }
  const organizations: {id: string; name: string; role: string; active: number}[] = []
  if (withWorkspaces) { organizations.push(...['첫 번째 팀','두 번째 팀'].map(name => ({id:crypto.randomUUID(),name,role:'owner',active:1}))); state.owned = 2 }
  const codes: Record<string, unknown>[] = []
  const requests: string[] = []
  window.fetch = async (input, init) => {
    const path = String(input).replace('/__beta-qa', '')
    if (!String(input).startsWith('/__beta-qa')) return originalFetch(input, init)
    requests.push(path)
    const body = init?.body ? JSON.parse(init.body as string) : null
    if (path === '/beta') return Response.json(state)
    if (path === '/beta/redeem') { state.active = true; return Response.json(state) }
    if (path === '/beta/codes') {
      if (body) { const id = crypto.randomUUID(); codes.unshift({id,label:body.label,maxUses:body.maxUses,used:0,expiresAt:Date.now()+86400000,revoked:0}); return Response.json({id,code:'0123-4567-89AB-CDEF-0123-4567-89AB-CDEF'}) }
      return Response.json(codes)
    }
    if (path === '/beta/codes/revoke') { codes.find(code => code.id === body.id)!.revoked = 1; return Response.json({ok:true}) }
    if (path === '/organizations') {
      if (!body) return Response.json(organizations)
      if (!state.active || state.owned >= 2) return Response.json({error:'workspace_limit'}, {status:409})
      const org = {id:crypto.randomUUID(),name:body.name,role:'owner',active:1}; organizations.push(org); state.owned++
      return Response.json(org)
    }
    if (path === '/organizations/invitations/preview') return Response.json({kind:'member',login:'qa',organization:'초대된 워크스페이스',accepted:false})
    if (path === '/organizations/invitations/accept') { const joined = {id:crypto.randomUUID(),name:'초대된 워크스페이스',role:'member',active:1}; organizations.push(joined); return Response.json(joined) }
    const org = organizations.find(org => path.startsWith('/organizations/' + org.id))
    if (org && path.endsWith('/requests')) return Response.json({requests:[]})
    if (org && path.endsWith('/catalog')) return Response.json({role:'owner',teams:[],projects:[]})
    if (org) return Response.json({...org,teams:[],members:[],invitations:[]})
    throw new Error('Unexpected QA request: ' + path)
  }
  function Screen() {
    const [route, navigate] = useState<ProRoute>({page:'start'})
    return <div className="app-window"><section className="pro-app"><div className="pro-topbar"><h1>EnvHandoff <span>Pro</span><small className="pro-badge">BETA</small></h1><span>QA 계정</span></div><ProOrganizations api="/__beta-qa" userId="qa" csrf="test" initialToken="" route={route} onNavigate={navigate} onResolvedOrganization={orgId => navigate(current => ({...current,orgId}))} settings={<p>내 설정</p>} disabled={false} onExpired={() => {throw new Error('Unexpected expiry')}} onAccepted={() => {}} /></section></div>
  }
  root.render(createElement(Screen))
  await until(() => !!host.querySelector('.pro-join-card') && !host.querySelector('[aria-busy="true"]'))
  return {host,state,requests,cleanup:() => {root.unmount();host.remove();window.fetch=originalFetch;document.querySelector<HTMLElement>('#root')!.hidden=false}}
}
const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000
  while (!condition()) { if (Date.now() > deadline) throw new Error('UI timed out'); await new Promise(resolve => setTimeout(resolve,20)) }
}
function input(host: HTMLElement, id: string, value: string) {
  const element = host.querySelector<HTMLInputElement>('#' + id)!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(element,value)
  element.dispatchEvent(new Event('input',{bubbles:true}))
}
export async function verifyBetaFlow() {
  const qa = await mountBetaQA(), {host} = qa
  const click = (text: string) => [...host.querySelectorAll<HTMLElement>('button,a')].find(el => el.textContent === text)!.click()
  try {
    check(!host.querySelector('nav[aria-label="워크스페이스 메뉴"]'), 'Empty account must not show workspace navigation')
    click('Pro Beta 참여하기'); await until(() => !!host.querySelector('#beta-code'))
    input(host,'beta-code','0123-4567-89AB-CDEF-0123-4567-89AB-CDEF'); click('Pro Beta 활성화')
    await until(() => host.textContent!.includes('Pro Beta가 활성화됐어요'))
    check(!host.textContent!.includes('참여 코드 발급'), 'Participant must not see operator issuance')
    click('워크스페이스 만들기'); await until(() => !!host.querySelector('dialog[open]'))
    check(document.activeElement?.id === 'new-workspace-name','Dialog must focus name')
    input(host,'new-workspace-name','첫 번째 팀'); await new Promise(resolve => setTimeout(resolve,20))
    host.querySelector<HTMLFormElement>('dialog form')!.requestSubmit()
    await until(() => host.textContent!.includes('첫 번째 팀') && !host.querySelector('dialog[open]'))
    host.querySelector<HTMLElement>('.pro-switcher summary')!.click(); click('새 워크스페이스 만들기')
    input(host,'new-workspace-name','두 번째 팀'); await new Promise(resolve => setTimeout(resolve,20))
    host.querySelector<HTMLFormElement>('dialog form')!.requestSubmit()
    await until(() => qa.state.owned === 2 && !host.querySelector('dialog[open]'))
    host.querySelector<HTMLElement>('.pro-switcher summary')!.click()
    const create = [...host.querySelectorAll<HTMLButtonElement>('button')].find(el => el.textContent === '새 워크스페이스 만들기')!
    check(create.disabled,'Third workspace action must be disabled')
    check(host.querySelectorAll('.pro-switcher-options > a').length === 2,'Both workspaces must remain switchable')
    host.querySelector('.pro-switcher')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))
    check(!host.querySelector<HTMLDetailsElement>('.pro-switcher')!.open,'Escape closes switcher')
    check(document.activeElement === host.querySelector('.pro-switcher summary'),'Escape returns focus')
    return {passed:true,checks:['no workspace onboarding','activation','operator UI isolation','dialog focus','two creations','quota','switcher Escape']}
  } finally { qa.cleanup() }
}

export async function verifyBetaOperator() {
  const qa = await mountBetaQA(true), {host} = qa
  const click = (text: string) => [...host.querySelectorAll<HTMLElement>('button,a')].find(el => el.textContent === text)!.click()
  try {
    click('베타 참여 관리'); await until(() => !!host.querySelector('#beta-label') && !host.querySelector('[aria-busy="true"]'))
    input(host,'beta-label','QA 그룹'); input(host,'beta-uses','3'); input(host,'beta-days','2')
    await new Promise(resolve => setTimeout(resolve,20)); click('코드 발급')
    await until(() => host.textContent!.includes('발급된 베타 코드') && !host.querySelector('[aria-busy="true"]'))
    check(host.textContent!.includes('0 / 3명 참여'), 'Issued limit should be visible')
    click('코드 숨기기'); await until(() => !host.querySelector('input[readonly]'))
    click('코드 취소'); await until(() => !!host.querySelector('[aria-label="코드 취소 확인"]'))
    click('취소 확인'); await until(() => host.textContent!.includes('취소됨'))
    check(qa.requests.includes('/beta/codes/revoke'),'Cancel should reach API')
    return {passed:true,checks:['operator issuance form','usage count','one-time code display','revocation confirmation']}
  } finally { qa.cleanup() }
}


export async function verifyWorkspaceNavigation() {
  const qa = await mountBetaQA(false, true), {host} = qa
  const click = (text: string) => [...host.querySelectorAll<HTMLElement>('button,a')].find(el => el.textContent === text)!.click()
  const selected = () => host.querySelector('.pro-switcher summary')!.textContent!
  const ready = () => !host.querySelector('[aria-busy="true"]')
  try {
    check(host.textContent!.includes('베타 코드 없이도'), 'Workspace invitation must explain independent access')
    check(host.querySelector('#workspace-invite-title') && host.querySelector('#beta-join-title'), 'Both admission paths must be visible')
    click('프로젝트'); await until(() => !!host.querySelector('nav a[aria-current="page"]') && ready())
    host.querySelector<HTMLElement>('.pro-switcher summary')!.click()
    const choices = host.querySelectorAll<HTMLAnchorElement>('.pro-switcher-options > a')
    choices[1]!.click(); await until(() => selected().includes('두 번째 팀') && ready())
    check(host.querySelector('nav a[aria-current="page"]')?.textContent === '프로젝트','Switching workspace must keep current page')
    click('워크스페이스 참여'); await until(() => !!host.querySelector('#invitation-link') && ready())
    check(selected().includes('두 번째 팀'), 'Opening participation must preserve the selected workspace')
    host.querySelector<HTMLElement>('.pro-switcher summary')!.click()
    host.querySelector<HTMLAnchorElement>('.pro-switcher-options > a[aria-current="true"]')!.click()
    await new Promise(resolve => setTimeout(resolve,20))
    check(!!host.querySelector('#invitation-link'), 'Selecting current workspace must not reset the page')
    input(host,'invitation-link','0123-4567-89AB-CDEF-0123-4567-89AB-CDEF')
    click('워크스페이스 초대 확인'); await until(() => !!host.querySelector('[role="alert"]'))
    check(!qa.requests.includes('/organizations/invitations/preview'), 'Wrong code type should not be sent as a workspace invitation')
    click('멤버 · 팀'); await until(() => !!host.querySelector('.pro-member-invitation') && ready())
    check(!host.querySelector('[role="alert"]'), 'Previous page errors must not follow navigation')
    click('워크스페이스에 멤버 초대')
    check(host.querySelector<HTMLDetailsElement>('.pro-member-invitation')!.open,'Invitation action must reveal its form')
    check(document.activeElement?.id === 'github-invite-login','Invitation action must focus GitHub input')
    check(!qa.state.active,'Workspace navigation must not activate beta')
    return {passed:true,checks:['distinct invitation types','page retained on switch','workspace retained on participation','wrong-code feedback','member invitation discovery and focus']}
  } finally { qa.cleanup() }
}


export async function verifyMemberInvitation() {
  const qa = await mountBetaQA(), {host} = qa
  const click = (text: string) => [...host.querySelectorAll<HTMLElement>('button,a')].find(el => el.textContent === text)!.click()
  try {
    input(host,'invitation-link', location.origin + '/pro#invite=' + 'a'.repeat(43))
    click('워크스페이스 초대 확인'); await until(() => host.textContent!.includes('초대된 워크스페이스에 참여하는 초대예요.'))
    click('초대 수락'); await until(() => host.querySelector('.pro-switcher summary')?.textContent?.includes('Member') === true && !host.querySelector('[aria-busy="true"]'))
    check(!qa.state.active && qa.state.owned === 0, 'Member invitation must not activate beta or consume ownership')
    check(!host.querySelector('#new-workspace-name')?.closest('dialog')?.open, 'Joining must not open creation')
    return {passed:true,checks:['workspace link preview','member acceptance without beta','ownership unchanged']}
  } finally { qa.cleanup() }
}
