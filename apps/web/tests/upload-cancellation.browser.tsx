import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { ProShares } from '../src/components/ProShares.tsx'
import { ProTransfer } from '../src/components/ProTransfer.tsx'
import type { ProRoute } from '../src/lib/pro-navigation.ts'
import { createLocalDevice, deleteLocalDevice, pinPeerIdentity } from '../src/lib/device-keys.ts'
import { deviceIdentity, identityFingerprint } from '@envhandoff/protocol/device-proof'

async function verifyCancellationRecovery(kind: 'share' | 'team') {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), originalFetch = window.fetch, originalConfirm = window.confirm
  const userId = crypto.randomUUID(), recipientId = crypto.randomUUID(), orgId = crypto.randomUUID(), environmentId = crypto.randomUUID(), requestId = crypto.randomUUID()
  const api = '/__cancel-recovery', base = api+'/organizations/'+orgId+(kind === 'share' ? '/shares' : '/requests/'+requestId+'/uploads')
  const ids: string[] = [], cancellationIds: string[] = []
  let route: ProRoute = {page:'shares',orgId,create:true}, completed = false, reserves = 0, cancellations = 0, queries = 0
  let cancellationStatus = 'cancelled', pause = false
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
  const until = async (condition: () => boolean) => {
    const end = Date.now()+5000
    // A mocked fetch can increment counters before React commits the click's
    // pending state. Let that commit happen before testing the rendered result.
    await new Promise(resolve=>setTimeout(resolve,20))
    while (!condition()) { if (Date.now()>end) throw new Error(kind+' cancellation recovery timed out: '+JSON.stringify({reserves,cancellations,queries,send:sendButton()?.textContent,route,html:host.innerHTML.slice(0,900)})+' '+host.textContent?.slice(0,350)); await new Promise(resolve=>setTimeout(resolve,20)) }
  }
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(node=>node.textContent===label)
  const sendButton = () => button('같은 업로드 재시도') ?? button(kind === 'share' ? '암호화해서 외부 공유' : '암호화해서 업로드')!
  const idle = () => !host.querySelector('[aria-busy="true"]')
  const render = () => root.render(kind === 'share' ? createElement(ProShares,{api,orgId,userId,csrf:'qa',route,onNavigate(next){route=next;render()},disabled:false,acceptNewTransfers:!pause,onExpired(){throw new Error('unexpected session expiry')}})
    : createElement(ProTransfer,{api,orgId,requestId,userId,csrf:'qa',sending:true,project:'QA',environment:'dev',acceptNewTransfers:!pause,onDone:async()=>{completed=true},onExpired(){throw new Error('unexpected session expiry')},onNavigate(){}}))
  try {
    const sender = kind === 'team' ? await createLocalDevice(userId,crypto.randomUUID()) : null
    const receiver = kind === 'team' ? await createLocalDevice(recipientId,crypto.randomUUID()) : null
    const peer = receiver ? await deviceIdentity(recipientId,receiver.deviceId,receiver.keys.publicKey,receiver.signingKeys.publicKey) : null
    if(sender && peer)await pinPeerIdentity(userId,peer,await identityFingerprint(peer))
    window.confirm=()=>true
    window.fetch=async(input,init)=>{
      const path=String(input)
      if(path.endsWith('/catalog'))return Response.json({projects:[{name:'QA',environments:[{id:environmentId,name:'dev',permissions:{externalShare:true}}]}]})
      if(kind==='team'&&path.endsWith('/transfer'))return Response.json({organizationId:orgId,requestId,senderUserId:userId,recipientUserId:recipientId,recipientDeviceId:receiver!.deviceId,receiver:peer,projectId:crypto.randomUUID(),environmentId,sessionHash:'qa'})
      if(path===base&&init?.method==='POST'){
        ids.push(JSON.parse(init.body as string).operationId);reserves++
        if(reserves===2)return Response.json({error:'storage_limit'},{status:429})
        throw new TypeError('Connection lost before response')
      }
      if(path.startsWith(base+'/')&&path.endsWith('/cancel')){
        cancellationIds.push(JSON.parse(init!.body as string).operationId);cancellations++
        if(cancellations===1)return Response.json({error:'storage_unavailable'},{status:503})
        return Response.json({id:ids.at(-1),status:cancellationStatus})
      }
      if(path===base+'/'+ids.at(-1)){
        queries++
        if(route.id)return Response.json({id:route.id,status:'available',createdAt:Date.now(),expiresAt:Date.now()+86400000,project:'QA',environment:'dev',canRevoke:true,canReissue:true})
        return Response.json({error:kind==='share'?'share_unavailable':'transfer_unavailable'},{status:404})
      }
      throw new Error('Unexpected recovery request '+path)
    }
    render()
    if(kind==='team'){await until(()=>!!button('상대 기기 확인'));button('상대 기기 확인')!.click()}
    await until(()=>!!host.querySelector('input[type="file"]')&&idle())
    const file=host.querySelector<HTMLInputElement>('input[type="file"]')!,data=new DataTransfer()
    data.items.add(new File(['PUBLIC_FIXTURE=not-a-secret\n'],'.env'));file.files=data.files;file.dispatchEvent(new Event('change',{bubbles:true}))
    await until(()=>!sendButton().disabled)
    sendButton().click();await until(()=>reserves===1&&idle()&&!!button('같은 업로드 재시도')&&!button('같은 업로드 재시도')!.matches(':disabled'))
    check(file.matches(':disabled'),'Unknown reservation outcome retains encrypted attempt')
    sendButton().click();await until(()=>reserves===2&&idle()&&!!button('같은 업로드 재시도')&&!button('같은 업로드 재시도')!.matches(':disabled'))
    check(ids[0]===ids[1]&&file.matches(':disabled'),'A rejected retry must not abandon the uncertain first reservation')
    button('업로드 상태 확인')!.click();await until(()=>queries===1&&idle())
    check(file.matches(':disabled'),'404 must not unlock a potentially delayed reservation')
    pause=true;render();await until(()=>sendButton().disabled)
    button('업로드 시도 취소')!.click();await until(()=>cancellations===1&&idle()&&host.textContent?.includes('파일 저장소가 아직 준비되지 않았어요.')===true)
    check(file.matches(':disabled')&&!!button('업로드 시도 취소'),'Unknown cancellation result retains originals and retry state')
    button('업로드 시도 취소')!.click();await until(()=>cancellations===2&&idle())
    check(cancellationIds[0]===cancellationIds[1],'Cancellation retries reuse operation ID')
    check(!file.matches(':disabled')&&!button('업로드 시도 취소'),'Authoritative cancellation unlocks source even when beta is paused')
    check([...host.querySelectorAll<HTMLInputElement>('input')].some(input=>input.value==='.env'),'Original placement path survives cancellation')
    pause=false;render();await until(()=>!sendButton().disabled)
    sendButton().click();await until(()=>reserves===3&&idle())
    check(ids[2]!==ids[0],'Confirmed cancellation permits a fresh encrypted reservation')
    cancellationStatus='available';button('업로드 시도 취소')!.click()
    await until(()=>cancellations===3&&idle()&&(kind==='share'?!!route.id:completed))
    if(kind==='share'){
      await until(()=>host.textContent?.includes('공유 코드')===true)
      check([...host.querySelectorAll<HTMLInputElement>('input')].some(input=>input.readOnly&&input.value.length>10&&!input.value.startsWith('http')),'Already committed share retains its only local code')
      check(host.textContent?.includes('상대에게 전달할 접근 링크'),'Already committed share restores link instead of revoking')
    }else check(!button('업로드 시도 취소')&&completed,'Already committed team upload completes rather than becoming a new upload')
    return {passed:true,checks:['unknown → rejected retry → 404 retains attempt','failed cancellation retries same operation','authoritative fence unlocks originals during beta pause','committed cancellation preserves delivery']}
  } finally {
    root.unmount();host.remove();window.fetch=originalFetch;window.confirm=originalConfirm
    if(kind==='team')await Promise.all([deleteLocalDevice(userId),deleteLocalDevice(recipientId)])
  }
}

export const verifyShareCancellationRecovery = () => verifyCancellationRecovery('share')
export const verifyTeamCancellationRecovery = () => verifyCancellationRecovery('team')
