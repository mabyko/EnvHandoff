import { useEffect, useRef, useState } from 'react'
import { betaClosedMessage, reservationRejected, uploadEncrypted } from '../lib/pro-feedback.ts'
import { proRequest, uploadResolution } from '../lib/pro-api.ts'
import { followProLink, proPath } from '../lib/pro-navigation.ts'
import type { ProRoute } from '../lib/pro-navigation.ts'
import { Notice } from './ui.tsx'
import { OpenedFiles } from './ReceiveFlow.tsx'
import { loadLocalDevice, pinPeerIdentity, trustedPeerEncryptionKey } from '../lib/device-keys.ts'
import { openTeamBundle, sealTeamBundle } from '../lib/team-crypto.ts'
import type { TeamBinding } from '../lib/team-crypto.ts'
import { explainError as bundleError, validateFiles } from '../lib/bundle.ts'
import type { OpenedBundle, SourceFile } from '../lib/bundle.ts'
import { deviceIdentity, deviceHash, answerDeviceChallenge } from '@envhandoff/protocol/device-proof'
import type { DeviceIdentity, EncryptedDeviceChallenge } from '@envhandoff/protocol/device-proof'
import { parseEditableEnv, previewEnvEdit } from '../lib/env.ts'

const explainError = (error: unknown) => error instanceof Error && error.name === 'Error' ? error.message : bundleError(error)
const MAX = 16 * 1024 * 1024 + 134
const errors: Record<string,string> = { beta_closed:betaClosedMessage, device_required:'요청에 지정된 기기로 접속해주세요. 기기 등록 상태도 확인해주세요.', transfer_unavailable:'만료되거나 회수된 전달이에요.', upload_unavailable:'이 업로드는 종료됐어요. 상태를 확인한 뒤 다시 준비해주세요.', request_closed:'요청이 종료됐어요.', storage_limit:'워크스페이스 저장 용량 또는 동시 업로드 한도에 도달했어요.', download_limit:'다운로드 한도에 도달했어요. 잠시 후 다시 시도해주세요.', invalid_proof:'기기 확인에 실패했어요. 상태를 새로 확인해주세요.', upload_in_progress:'진행 중인 업로드가 있어요. 완료하거나 취소한 뒤 다시 시도해주세요.', file_permission_required:'파일 권한이 바뀌었어요.', storage_unavailable:'파일 저장소가 아직 준비되지 않았어요.' }
type Context = { pendingUpload?: {id:string;status:string}; sessionHash:string; sender?:DeviceIdentity; receiver:DeviceIdentity; binding?:TeamBinding; organizationId?:string; projectId?:string; environmentId?:string; requestId?:string; senderUserId?:string; recipientUserId?:string; recipientDeviceId?:string; id?:string; status?:string; size?:number; digest?:string }
type Pending = { id:string; bytes:ArrayBuffer; digest:string; days:number; deviceId:string }

export function ProTransfer({ api,orgId,requestId,userId,csrf,sending,project,environment,acceptNewTransfers=true,onDone,onExpired,onNavigate }: { api:string;orgId:string;requestId:string;userId:string;csrf:string;sending:boolean;project:string;environment:string;acceptNewTransfers?:boolean;onDone:()=>Promise<void>;onExpired:()=>void;onNavigate:(route:ProRoute)=>void }) {
 const [context,setContext]=useState<Context|null>(null),[trusted,setTrusted]=useState(false),[fingerprint,setFingerprint]=useState('')
 const [files,setFiles]=useState<SourceFile[]>([]),[days,setDays]=useState(1),[opened,setOpened]=useState<OpenedBundle|null>(null)
 const [pending,setPending]=useState<Pending|null>(null),[busy,setBusy]=useState(false),[progress,setProgress]=useState(0),[error,setError]=useState(''),[message,setMessage]=useState('')
 const [editing,setEditing]=useState<{index:number;source:ReturnType<typeof parseEditableEnv>;values:string[]}|null>(null)
 const lifetime=useRef<AbortController|null>(null),work=useRef<AbortController|null>(null)
 const cancellation=useRef<AbortController|null>(null),[cancelling,setCancelling]=useState(false),[operation,setOperation]=useState('')
 const cancellations=useRef(new Map<string,string>())
 const base=`/organizations/${orgId}/requests/${requestId}`
 const peer=context && (sending?context.receiver:context.sender)
 useEffect(()=>{const controller=new AbortController();lifetime.current=controller;return()=>{controller.abort();work.current?.abort();cancellation.current?.abort()}},[])
 useEffect(()=>{if(!files.length&&!opened&&!pending)return;const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn)},[files,opened,pending])
 async function call(path:string,body?:Record<string,unknown>,signal=lifetime.current!.signal) {
  return proRequest(api+base+path,{csrf,signal,body,errors,onExpired})
 }

 async function run(action:(signal:AbortSignal)=>Promise<void>,label='처리 중…') {
  if(work.current||cancellation.current)return
  const controller=new AbortController();work.current=controller;setBusy(true);setOperation(label);setError('');setMessage('')
  const signal=AbortSignal.any([controller.signal,lifetime.current!.signal])
  try{await action(signal)}catch(e){if(!signal.aborted)setError(explainError(e))}
  finally{if(work.current===controller)work.current=null;if(!lifetime.current?.signal.aborted)setBusy(false)}
 }
 async function inspect(signal:AbortSignal) {
  setOpened(null);setTrusted(false)
  const value:Context=await (await call('/transfer',undefined,signal)).json()
  if(value.status && value.status!=='available')throw new Error('만료되거나 회수된 전달이에요.')
  if(sending && (value.organizationId!==orgId||value.requestId!==requestId||value.senderUserId!==userId))throw new Error('요청 정보를 확인해주세요.')
  if(!sending && (value.binding?.organizationId!==orgId||value.binding.requestId!==requestId||value.binding.recipientUserId!==userId))throw new Error('수신 요청 정보를 확인해주세요.')
  const local=await loadLocalDevice(userId)
  if(!local)throw new Error(sending?'설정에서 이 브라우저의 기기를 먼저 등록해주세요.':'이 요청을 만든 원래 브라우저 기기에 키가 있어요. 원래 기기에서 열거나 새 요청으로 다시 받아주세요.')
  if(!sending && local.deviceId!==value.binding!.recipientDeviceId)throw new Error('이 요청을 만든 원래 브라우저 기기에서 열어주세요. 새 기기는 새 요청이 필요해요.')
  const other=sending?value.receiver:value.sender!
  const expectedUser=sending?value.recipientUserId:value.binding!.senderUserId
  const expectedDevice=sending?value.recipientDeviceId:value.binding!.senderDeviceId
  if(!other||other.userId!==expectedUser||other.deviceId!==expectedDevice)throw new Error('상대 기기 정보가 요청과 달라요.')
  let known=false
  try{await trustedPeerEncryptionKey(userId,other);known=true}catch{ /* An explicit fingerprint check is required. */ }
  if(signal.aborted)return
  setContext(value);setTrusted(known)
 }
 async function prove(action:'upload'|'download'|'ack',info:Context,upload:Pending|undefined,signal:AbortSignal) {
  const local=await loadLocalDevice(userId)
  if(!local)throw new Error('등록된 기기 키가 없어요.')
  if(!sending&&local.deviceId!==info.binding!.recipientDeviceId)throw new Error('지정된 수신 기기에서 열어주세요.')
  const actor=await deviceIdentity(userId,local.deviceId,local.keys.publicKey,local.signingKeys.publicKey)
  const path=action==='upload'?'/uploads/'+upload!.id:'/transfer'
  const wire:EncryptedDeviceChallenge=await (await call(path+'/challenge',{action,deviceId:local.deviceId},signal)).json()
  const expected={id:wire.challenge.id,issuedAt:wire.challenge.issuedAt,expiresAt:wire.challenge.expiresAt,action,actor,target:actor,sessionHash:info.sessionHash,
   scope:{organizationId:orgId,requestId,transferId:upload?.id??info.binding!.transferId,digest:upload?.digest??info.digest!}}
  return {id:wire.challenge.id,proof:await answerDeviceChallenge(wire,expected,local.keys,local.signingKeys.privateKey)}
 }
 async function cancelUpload(id:string,signal=lifetime.current!.signal) {
  const operationId=cancellations.current.get(id)??crypto.randomUUID();cancellations.current.set(id,operationId)
  const result:{status:string}=await (await call('/uploads/'+id+'/cancel',{operationId},signal)).json()
  signal.throwIfAborted()
  if(uploadResolution(result.status)==='pending')throw new Error('취소 결과를 확인하지 못했어요. 같은 시도를 다시 취소해주세요.')
  cancellations.current.delete(id)
  return result
 }
 async function stopUpload() {
  if(!pending||cancellation.current)return
  const controller=new AbortController();cancellation.current=controller;setCancelling(true);setError('');setMessage('')
  work.current?.abort()
  const signal=AbortSignal.any([controller.signal,lifetime.current!.signal])
  try {
   const result=await cancelUpload(pending.id,signal)
   if(!signal.aborted){
    setPending(null);setProgress(0)
    if(uploadResolution(result.status)==='complete'){setFiles([]);setMessage('업로드가 이미 완료됐어요.');await onDone()}
    else setMessage('업로드 시도를 취소했어요. 원본으로 새로 준비할 수 있어요.')
   }
  } catch(error) {if(!signal.aborted)setError(explainError(error))}
  finally{if(cancellation.current===controller)cancellation.current=null;if(!lifetime.current?.signal.aborted)setCancelling(false)}
 }
 async function send(signal:AbortSignal) {
  if(!acceptNewTransfers)throw new Error(betaClosedMessage)
  const firstAttempt=!pending
  if(!context||!peer)throw new Error('상대 기기를 먼저 확인해주세요.')
  const local=await loadLocalDevice(userId);if(!local)throw new Error('기기를 먼저 등록해주세요.')
  const key=await trustedPeerEncryptionKey(userId,peer)
  let upload=pending
  if(!upload){
   validateFiles(files.map(file=>({path:file.path,size:file.file.size})))
   const transferId=crypto.randomUUID()
   const binding:TeamBinding={organizationId:orgId,projectId:context.projectId!,environmentId:context.environmentId!,requestId,transferId,senderUserId:userId,senderDeviceId:local.deviceId,recipientUserId:peer.userId,recipientDeviceId:peer.deviceId}
   const bytes=await sealTeamBundle(files,project,environment,binding,local.keys,key)
   upload={id:transferId,bytes,digest:await deviceHash(new Uint8Array(bytes)),days,deviceId:local.deviceId}
   if(signal.aborted)return
   setPending(upload)
  }
  let reserved:{status:string}
  try{reserved=await(await call('/uploads',{operationId:upload.id,deviceId:upload.deviceId,size:upload.bytes.byteLength,digest:upload.digest,retentionDays:upload.days},signal)).json()}
  catch(error){if(firstAttempt&&reservationRejected(error)&&!signal.aborted)setPending(null);throw error}
  if(signal.aborted)return
  if(reserved.status==='available'){setFiles([]);setPending(null);await onDone();return}
  if(reserved.status!=='reserved')throw new Error('업로드 상태를 확인한 뒤 새 시도를 준비해주세요.')
  const proof=await prove('upload',context,upload,signal)
  setProgress(0)
  try { await uploadEncrypted(api+base+'/uploads/'+upload.id+'/content',upload.bytes,{'x-csrf-token':csrf,'x-device-challenge':proof.id,'x-device-proof':proof.proof},signal,setProgress) }
  catch(e){if(e instanceof Error&&e.name==='SessionExpired')onExpired();throw e}
  if(signal.aborted)return
  setProgress(100);setFiles([]);setPending(null);await onDone()
 }
 async function receive(signal:AbortSignal) {
  if(!context||!peer)throw new Error('상대 기기를 먼저 확인해주세요.')
  setOpened(null)
  const local=await loadLocalDevice(userId);if(!local)throw new Error('기기 키가 없어요.')
  const key=await trustedPeerEncryptionKey(userId,peer)
  const info:Context=await (await call('/transfer',undefined,signal)).json()
  if(info.status!=='available'||JSON.stringify(info.binding)!==JSON.stringify(context.binding)||JSON.stringify(info.sender)!==JSON.stringify(peer))throw new Error('전달 상태나 기기가 바뀌었어요. 다시 확인해주세요.')
  if(!Number.isSafeInteger(info.size)||info.size!<174||info.size!>MAX)throw new Error('잘못된 전달 크기예요.')
  const response=await call('/transfer/content',await prove('download',info,undefined,signal),signal)
  const reader=response.body!.getReader(),chunks:Uint8Array[]= [];let size=0
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>info.size!)throw new Error('전달 크기가 달라요.');chunks.push(value)}}finally{await reader.cancel();reader.releaseLock()}
  if(size!==info.size)throw new Error('전달 파일이 잘렸어요.')
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  if(await deviceHash(bytes)!==info.digest)throw new Error('전달 파일이 변경됐어요.')
  const bundle=await openTeamBundle(bytes.buffer,info.binding!,local.keys,key)
  if(signal.aborted)return
  setOpened(bundle)
  try{await call('/transfer/ack',{...await prove('ack',info,undefined,signal),operationId:crypto.randomUUID()},signal);if(!signal.aborted){setMessage('파일 검사를 통과했고 수신 확인을 남겼어요.');await onDone()}}
  catch(e){if(!signal.aborted)setMessage('파일은 열었지만 수신 확인을 저장하지 못했어요. 파일을 다시 열면 재시도해요.');throw e}
 }
 const editingSource=editing
 return <section className="pro-transfer" aria-label={sending?'파일 전달':'전달 파일 열기'} aria-busy={busy||cancelling} data-work-loss={!!files.length || !!opened || !!pending}>
  {sending&&!acceptNewTransfers&&<Notice>{betaClosedMessage}</Notice>}
  {error&&<Notice error>{error}</Notice>}{message&&<p role="status">{message}</p>}
  <fieldset disabled={busy||cancelling} className="plain-fieldset pro-panel">
   <legend>{sending?'암호화해서 보내기':'내 기기로 파일 열기'}</legend>
   <p className="help">{sending?'상대 기기를 확인한 뒤 보낼 파일을 선택하세요.':'상대 기기를 확인하고 이 브라우저에서 파일을 열어보세요.'}</p>
   <div className="actions"><button type="button" className={context?'button':'button primary'} onClick={()=>{void run(inspect,'상대 기기 확인 중…')}}>상대 기기 확인</button><a className="text-button" href={proPath({page:'settings',orgId})} onClick={event=>followProLink(event,{page:'settings',orgId},onNavigate)}>내 기기 등록·관리</a></div>
   {!sending&&<p>새 기기로는 과거 파일을 열 수 없어요. 원래 브라우저에서 열거나 <a href={proPath({page:'requests',orgId,create:true})} onClick={event=>followProLink(event,{page:'requests',orgId,create:true},onNavigate)}>새 파일 요청</a>으로 다시 받아주세요.</p>}
   {peer&&<><p>상대 계정: {peer.userId}<br/>상대 기기: {peer.deviceId}</p>
    {!trusted?<form className="pro-form" onSubmit={e=>{e.preventDefault();void run(async signal=>{await pinPeerIdentity(userId,peer,fingerprint.trim());if(!signal.aborted){setTrusted(true);setFingerprint('')}})}}>
     <label>별도 대화로 받은 상대 기기 지문<input value={fingerprint} onChange={e=>setFingerprint(e.target.value)} required maxLength={43} autoComplete="off" spellCheck={false}/></label>
     <p className="help">알고 있는 연락 경로에서 상대의 계정·기기·지문을 대조해주세요.</p><button className="button primary" type="submit">지문 대조 후 저장</button>
    </form>:<p>이 브라우저에 확인한 상대 기기가 저장돼 있어요.</p>}</>}
   {context?.pendingUpload&&!pending&&<><p>이 요청에 이전 업로드가 남아 있어요. 파일을 잃었다면 이전 시도를 취소한 뒤 다시 선택해주세요.</p><button className="button" type="button" onClick={()=>{if(window.confirm('다른 탭에서 진행 중인 업로드도 중단돼요. 이전 업로드 시도를 취소할까요?'))void run(async signal=>{const result=await cancelUpload(context.pendingUpload!.id,signal);if(uploadResolution(result.status)==='complete')await onDone();else await inspect(signal)})}}>이전 업로드 취소</button></>}
   {trusted&&sending&&<>
    <label className="pro-form">보낼 파일<input type="file" multiple disabled={!!pending} onChange={e=>{const selected=Array.from(e.target.files??[]).map(file=>({file,path:file.name}));try{validateFiles(selected.map(x=>({path:x.path,size:x.file.size})));setFiles(selected);setEditing(null)}catch(error){setError(explainError(error))}e.target.value=''}}/></label>
    {files.map((file,index)=><div className="pro-form" key={index}><label>배치 경로<input value={file.path} disabled={!!pending} onChange={e=>setFiles(current=>current.map((f,i)=>i===index?{...f,path:e.target.value}:f))}/></label>
     {file.path.split('/').at(-1)?.startsWith('.env')&&<button className="button" type="button" disabled={!!pending} onClick={()=>{void run(async signal=>{const source=parseEditableEnv(new Uint8Array(await file.file.arrayBuffer()));if(!signal.aborted)setEditing({index,source,values:source.entries.map(x=>x.value)})})}}>환경변수 편집</button>}
    </div>)}
    {editingSource&&<form className="pro-form" onSubmit={e=>{e.preventDefault();try{const preview=previewEnvEdit(editingSource.source,editingSource.values);if(!window.confirm('수정한 환경변수 값을 보낼 파일에 적용할까요?'))return;setFiles(current=>current.map((f,i)=>i===editingSource.index?{...f,file:new File([preview.text],f.file.name)}:f));setEditing(null)}catch(error){setError(explainError(error))}}}>
     {editingSource.source.entries.map((entry,index)=><label key={index}>{entry.key}<input autoComplete="off" spellCheck={false} value={editingSource.values[index]} onChange={e=>setEditing({...editingSource,values:editingSource.values.map((v,i)=>i===index?e.target.value:v)})}/></label>)}
     <button className="button" type="submit">수정본 적용</button><button className="button" type="button" onClick={()=>setEditing(null)}>편집 취소</button>
    </form>}
    <label className="pro-form">보관 기간<select value={days} disabled={!!pending} onChange={e=>setDays(Number(e.target.value))}><option value={1}>24시간</option><option value={3}>3일</option><option value={7}>7일</option></select></label>
    <p>조직·프로젝트·환경 이름은 서버에 저장돼요. 파일 이름·배치 경로·내용은 암호화된 묶음 안에만 담겨요.</p>
    <p>업로드 확정부터 이용할 수 있는 기간이에요. 만료·회수 뒤 저장소 삭제까지 최대 24시간이 더 걸릴 수 있어요.</p>
    <button className="button primary" type="button" disabled={!acceptNewTransfers||!files.length||!!editing} onClick={()=>{void run(send,'암호화·업로드 처리 중…')}}>{pending?'같은 업로드 재시도':'암호화해서 업로드'}</button>
   </>}
   {trusted&&!sending&&<p>수신 확인은 이 브라우저가 파일 검사를 마쳤다는 보고예요. 파일 저장이나 프로젝트 적용 여부를 보장하지 않아요.</p>}
   {trusted&&!sending&&<button className="button primary" type="button" onClick={()=>{void run(receive,'파일 다운로드·검사 중…')}}>파일 다운로드·검사</button>}
   {pending&&<button className="button" type="button" onClick={()=>{void run(async signal=>{const value=await(await call('/uploads/'+pending.id,undefined,signal)).json();if(signal.aborted)return;if(uploadResolution(value.status)==='complete'){setFiles([]);setPending(null);await onDone()}else if(uploadResolution(value.status)==='ended'){setPending(null);setProgress(0);setMessage('이전 업로드는 종료됐어요. 새로 업로드할 수 있어요.')}else setMessage(value.status==='writing'?'서버가 파일을 저장하고 있어요. 완료 응답을 기다리거나 잠시 후 상태를 다시 확인해주세요.':'업로드 대기 중이에요. 같은 업로드를 재시도할 수 있어요.')})}}>업로드 상태 확인</button>}
  </fieldset>
  <p className="pro-operation-status" role="status">{cancelling?'업로드 취소 확인 중…':busy?operation:''}</p>
  {busy&&sending&&operation==='암호화·업로드 처리 중…'&&progress>0&&<progress max={100} value={progress} aria-label="파일 업로드 진행률"/>}
  {pending&&<button className="button destructive" type="button" disabled={cancelling} onClick={()=>{void stopUpload()}}>{cancelling?'취소 확인 중…':'업로드 시도 취소'}</button>}
  {opened&&<><OpenedFiles bundle={opened}/><button className="button" type="button" onClick={()=>setOpened(null)}>열어둔 파일 닫기</button></>}
 </section>
}
