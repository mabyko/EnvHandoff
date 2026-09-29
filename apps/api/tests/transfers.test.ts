import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rmdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { join } from 'node:path'
import { AuthApi } from '../src/auth.ts'
import { fixture, config, DAY } from './request-fixture.ts'
import { answerDeviceChallenge, deviceIdentity, deviceHash } from '@envhandoff/protocol/device-proof'
import { sealTeamBundle, openTeamBundle } from '../../web/src/lib/team-crypto.ts'
import type { EncryptedDeviceChallenge } from '@envhandoff/protocol/device-proof'

async function transfer(t: TestContext, original=new Uint8Array([0xef,0xbb,0xbf,65,61,49,13,10])) {
  const f = await fixture(t)
  const encryption = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' },false,['deriveBits'])
  const signing = await crypto.subtle.generateKey({ name:'ECDSA', namedCurve:'P-256' },false,['sign','verify'])
  const identity = await deviceIdentity(f.sender.id,randomUUID(),encryption.publicKey,signing.publicKey)
  const auth = { userId:f.sender.id, sessionId:f.sender.hash, reauthenticatedAt:f.now(), active:true }
  const wire = await f.registry.beginRegistration(auth,identity)
  await f.registry.complete(auth,wire.challenge.id,await answerDeviceChallenge(wire,wire.challenge,encryption,signing.privateKey,f.now()))
  const r = await f.create()
  await f.ok(f.sender,'/'+r.id+'/approve',{operationId:randomUUID()})
  const uploadId=randomUUID(), base='/'+r.id
  const binding={organizationId:f.orgId,projectId:f.project.id,environmentId:f.environment.id,requestId:r.id,transferId:uploadId,senderUserId:f.sender.id,senderDeviceId:identity.deviceId,recipientUserId:f.receiver.id,recipientDeviceId:f.identity.deviceId}
  const bytes=await sealTeamBundle([{file:new File([original],'test.env'),path:'services/test.env'}],'QA','dev',binding,encryption,f.encryption.publicKey)
  const digest=await deviceHash(new Uint8Array(bytes))
  const reserve={operationId:uploadId,deviceId:identity.deviceId,size:bytes.byteLength,digest,retentionDays:7}
  const prepare=()=>f.ok(f.sender,base+'/uploads',reserve)
  const prove=async(action:'upload'|'download'|'ack')=>{
    const sender=action==='upload',user=sender?f.sender:f.receiver
    const route=base+(sender?'/uploads/'+uploadId:'/transfer')+'/challenge'
    const wire:EncryptedDeviceChallenge=await f.ok(user,route,{action,deviceId:sender?identity.deviceId:f.identity.deviceId})
    const expected={...wire.challenge,action,actor:sender?identity:f.identity,target:sender?identity:f.identity,scope:{organizationId:f.orgId,requestId:r.id,transferId:uploadId,digest},sessionHash:await deviceHash(user.hash)}
    return {...(action==='ack'?{operationId:randomUUID()}:{}),id:wire.challenge.id,proof:await answerDeviceChallenge(wire,expected,sender?encryption:f.encryption,sender?signing.privateKey:f.signing.privateKey,f.now())}
  }
  const upload=async(body:BodyInit=bytes, selectedApi=f.api)=>{
    const proof=await prove('upload')
    return selectedApi.handle(new Request(config.apiOrigin+f.path+base+'/uploads/'+uploadId+'/content',{method:'POST',headers:{origin:config.webOrigin,cookie:'envhandoff-dev-session='+f.sender.token,'content-type':'application/octet-stream','x-csrf-token':f.sender.csrf,'x-device-challenge':proof.id,'x-device-proof':proof.proof},body,duplex:'half'} as RequestInit))
  }
  return {...f,identitySender:identity,binding,original,bytes,digest,uploadId,base,reserve,prepare,prove,upload,senderEncryption:encryption,senderSigning:signing.privateKey}
}

test('real encrypted transfer persists across restart and sender logout; only fixed receiver gets bytes, ACK keeps expiry and re-download',async t=>{
 const f=await transfer(t)
 const [a,b]=await Promise.all([f.prepare(),f.prepare()]);assert.deepEqual(a,b)
 assert.equal((await f.upload()).status,200)
 assert.equal((await f.ok(f.receiver,f.base)).status,'fulfilled')
 const stored=await readFile(join(f.fileStoragePath,f.uploadId));assert.equal(stored.includes(Buffer.from('services/test.env')),false)
 const restart=new AuthApi(f.storage.connect(),f.localConfig,fetch,f.now)
 await f.db.run('DELETE FROM sessions WHERE token_hash=$1',f.sender.hash)
 const info=await f.ok(f.receiver,f.base+'/transfer',undefined,restart)
 assert.equal(info.status,'available');assert.deepEqual(info.binding,f.binding)
 const proof=await f.prove('download')
 assert.equal((await f.call(f.owner,f.base+'/transfer/content',proof)).status,404)
 assert.equal((await f.call(f.other,f.base+'/transfer/content',proof)).status,404)
 const response=await f.call(f.receiver,f.base+'/transfer/content',proof,restart)
 assert.equal(response.status,200)
 const bytes=await response.arrayBuffer();assert.deepEqual(bytes,f.bytes)
 const opened=await openTeamBundle(bytes,f.binding,f.encryption,f.senderEncryption.publicKey)
 assert.deepEqual(opened.files[0]!.bytes,f.original)
 assert.equal((await f.call(f.receiver,f.base+'/transfer/content',proof)).status,403)
 const ack=await f.prove('ack');assert.equal((await f.call(f.receiver,f.base+'/transfer/ack',ack)).status,200)
 const after=await f.ok(f.receiver,f.base+'/transfer');assert.equal(after.expiresAt,info.expiresAt);assert.equal(after.acknowledgedAt,f.now())
 await f.advance(1000)
 await f.ok(f.receiver,f.base+'/transfer/ack',await f.prove('ack'))
 assert.equal((await f.ok(f.receiver,f.base+'/transfer')).acknowledgedAt,after.acknowledgedAt)
 const again=await f.call(f.receiver,f.base+'/transfer/content',await f.prove('download'));assert.equal(again.status,200);await again.arrayBuffer()
 assert.equal((await f.db.get('SELECT sum(bytes)::bigint AS n FROM download_leases'))!.n,2*f.bytes.byteLength)
})

test('beta closure blocks new requests and uploads, preserves retries and existing transfer download/ACK', async t => {
  const f = await transfer(t)
  const closed = new AuthApi(f.storage.connect(), { ...f.localConfig, acceptNewTransfers: false }, fetch, f.now)
  const rejected = await f.call(f.receiver, '', f.input(), closed)
  assert.equal(rejected.status, 503); assert.equal((await rejected.json()).error, 'beta_closed')
  assert.equal((await f.call(f.sender, f.base + '/uploads', f.reserve, closed)).status, 503)
  await f.prepare()
  assert.equal((await f.ok(f.sender, f.base + '/uploads', f.reserve, closed)).status, 'reserved')
  assert.equal((await f.upload(f.bytes, closed)).status, 503)
  assert.equal((await f.upload()).status, 200)
  const info = await f.ok(f.receiver, f.base + '/transfer', undefined, closed)
  const result = await f.call(f.receiver, f.base + '/transfer/content', await f.prove('download'), closed)
  assert.equal(result.status, 200); assert.deepEqual(await result.arrayBuffer(), f.bytes)
  await f.ok(f.receiver, f.base + '/transfer/ack', await f.prove('ack'), closed)
  assert.equal((await f.ok(f.receiver, f.base + '/transfer', undefined, closed)).expiresAt, info.expiresAt)
})

test('upload enforces declared bytes and digest; cancellation during stream wins and pending files are physically removed',async t=>{
 const f=await transfer(t);await f.prepare()
 let release!:()=>void, started!:()=>void
 const waiting=new Promise<void>(r=>{release=r}),reading=new Promise<void>(r=>{started=r})
 const stream=new ReadableStream({async pull(controller){started();await waiting;controller.enqueue(new Uint8Array(f.bytes));controller.close()}})
 const operation=f.upload(stream);await reading
 // Wait for the actual reservation to become writing, not merely the stream constructor's first pull.
 for(let i=0;i<100;i++){if((await f.db.get('SELECT status FROM uploads WHERE id=$1',f.uploadId))!.status==='writing')break;await new Promise(r=>setTimeout(r,5))}
 await f.ok(f.receiver,f.base+'/cancel',{operationId:randomUUID()});release()
 assert.equal((await operation).status,409)
 assert.equal((await f.ok(f.receiver,f.base)).status,'cancelled')
 await f.api.prune();assert.deepEqual(await readdir(f.fileStoragePath),[])
 const g=await transfer(t);await g.prepare()
 const bad=new Uint8Array(g.bytes.slice(0));bad[bad.length-1]^=1
 assert.equal((await g.upload(bad)).status,400)
 assert.equal((await g.db.get('SELECT status FROM uploads WHERE id=$1',g.uploadId))!.status,'failed')
 await g.api.prune();assert.deepEqual(await readdir(g.fileStoragePath),[])
})

test('receiver device, proof action, session and transfer digest are bound; revocation and regrant never reopen committed bytes',async t=>{
 const f=await transfer(t);await f.prepare();assert.equal((await f.upload()).status,200)
 assert.equal((await f.call(f.receiver,f.base+'/transfer/challenge',{action:'download',deviceId:randomUUID()})).status,403)
 const ack=await f.prove('ack')
 assert.equal((await f.call(f.receiver,f.base+'/transfer/content',{id:ack.id,proof:ack.proof})).status,403)
 const proof=await f.prove('download')
 await f.organizations.setPermissions(f.owner.id,f.orgId,f.environment.id,f.receiver.id,false,false,false)
 assert.equal((await f.db.get('SELECT revoked_at FROM uploads WHERE id=$1',f.uploadId))!.revoked_at,f.now())
 await f.organizations.setPermissions(f.owner.id,f.orgId,f.environment.id,f.receiver.id,true,false,false)
 assert.equal((await f.call(f.receiver,f.base+'/transfer/content',proof)).status,410)
 const summary=await f.ok(f.receiver,f.base);assert.equal(summary.transfer.status,'revoked')
 await f.api.prune();assert.deepEqual(await readdir(f.fileStoragePath),[])
})

test('request deadline and retention are separate; expiry blocks new proof, cleans objects, retains ACK and later prunes receipts',async t=>{
 const f=await transfer(t);await f.advance(6*DAY);await f.prepare();assert.equal((await f.upload()).status,200)
 const info=await f.ok(f.receiver,f.base+'/transfer');assert.equal(info.expiresAt,f.now()+7*DAY)
 await f.ok(f.receiver,f.base+'/transfer/ack',await f.prove('ack'))
 await f.advance(DAY+1);assert.equal((await f.ok(f.receiver,f.base+'/transfer')).status,'available')
 await f.advance(6*DAY);await f.api.prune()
 assert.equal((await f.ok(f.receiver,f.base)).transfer.status,'expired')
 assert.equal((await f.call(f.receiver,f.base+'/transfer/challenge',{action:'download',deviceId:f.identity.deviceId})).status,410)
 assert.deepEqual(await readdir(f.fileStoragePath),[])
 await f.advance(31*DAY);await f.api.prune();assert.equal((await f.db.get('SELECT count(*) AS n FROM uploads'))!.n,0)
})

test('concurrent download reservations enforce limits and charge partial consumption; oversized quota and changed reservation reject',async t=>{
 const f=await transfer(t);await f.prepare()
 assert.equal((await f.call(f.sender,f.base+'/uploads',{operationId:f.uploadId,deviceId:f.identitySender.deviceId,size:f.bytes.byteLength,digest:f.digest,retentionDays:1})).status,409)
 assert.equal((await f.upload()).status,200)
 const responses=[]
 for(let i=0;i<3;i++){const response=await f.call(f.receiver,f.base+'/transfer/content',await f.prove('download'));assert.equal(response.status,200);responses.push(response)}
 assert.equal((await f.call(f.receiver,f.base+'/transfer/content',await f.prove('download'))).status,429)
 for(const response of responses)await response.body!.cancel()
 assert.equal((await f.db.get('SELECT sum(bytes)::bigint AS n FROM download_leases'))!.n,0)
 await f.db.run('UPDATE download_leases SET bytes=$1 WHERE id=(SELECT id FROM download_leases LIMIT 1)',1024*1024*1024)
 assert.equal((await f.call(f.receiver,f.base+'/transfer/content',await f.prove('download'))).status,429)
 assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='download_denied' AND target_id=$1",f.uploadId))!.n,1)
})

test('team download denials survive rollback, retain opaque responses and suppress concurrent duplicate audit across instances', async t => {
  const f = await transfer(t); await f.prepare(); assert.equal((await f.upload()).status, 200)
  const proof = await f.prove('download')
  const invalid = { ...proof, proof: 'private-invalid-proof' }
  const responses = await Promise.all([f.call(f.receiver, f.base + '/transfer/content', invalid), f.call(f.receiver, f.base + '/transfer/content', invalid, f.api2)])
  assert.ok(responses.every(r => r.status === 403))
  assert.deepEqual(await f.db.all("SELECT org_id,actor_id,target_id,event,created_at FROM organization_events WHERE event='download_denied'"),
    [{ org_id: f.orgId, actor_id: f.receiver.id, target_id: f.uploadId, event: 'download_denied', created_at: f.now() }])
  assert.ok(await f.db.get('SELECT 1 FROM transfer_challenges WHERE id=$1', proof.id))
  assert.equal((await f.db.get('SELECT count(*) AS n FROM download_leases'))!.n, 0)
  await f.advance(60_000)
  const known = await f.call(f.other, f.base + '/transfer/content', invalid)
  const absent = await f.call(f.other, '/' + randomUUID() + '/transfer/content', invalid)
  assert.equal(known.status, 404); assert.equal(absent.status, 404); assert.deepEqual(await known.json(), await absent.json())
  assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='download_denied'"))!.n, 2)
  assert.equal((await f.db.get("SELECT actor_id FROM organization_events WHERE event='download_denied' ORDER BY id DESC LIMIT 1"))!.actor_id, f.other.id)
  const allEvents = JSON.stringify(await f.db.all('SELECT * FROM organization_events'))
  for (const secret of [invalid.proof, proof.proof, f.receiver.token, 'services/test.env']) assert.equal(allEvents.includes(secret), false)
})

test('device, permission and retention denials are audited without granting a download lease', async t => {
  const f = await transfer(t); await f.prepare(); assert.equal((await f.upload()).status, 200)
  const challenge = { action: 'download', deviceId: f.identity.deviceId }
  assert.equal((await f.call(f.receiver, f.base + '/transfer/challenge', { ...challenge, deviceId: randomUUID() })).status, 403)
  await f.advance(60_000)
  await f.organizations.setPermissions(f.owner.id, f.orgId, f.environment.id, f.receiver.id, false, true, false)
  assert.equal((await f.call(f.receiver, f.base + '/transfer/challenge', challenge)).status, 410)
  assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='download_denied' AND target_id=$1", f.uploadId))!.n, 2)
  const g = await transfer(t); await g.prepare(); assert.equal((await g.upload()).status, 200)
  await g.advance(8 * DAY)
  assert.equal((await g.call(g.receiver, g.base + '/transfer/challenge', { action: 'download', deviceId: g.identity.deviceId })).status, 410)
  assert.equal((await g.db.get("SELECT count(*) AS n FROM organization_events WHERE event='download_denied' AND target_id=$1", g.uploadId))!.n, 1)
  assert.equal((await g.db.get('SELECT count(*) AS n FROM download_leases'))!.n, 0)
})

test('quota denial keeps its audit while rollback restores the consumed device challenge', async t => {
  const f = await transfer(t); await f.prepare(); assert.equal((await f.upload()).status, 200)
  const proof = await f.prove('download')
  await f.db.run('INSERT INTO download_leases(id,upload_id,org_id,day,bytes,expires_at,finished) VALUES($1,$2,$3,$4,$5,$6,1)', randomUUID(), f.uploadId, f.orgId, Math.floor(f.now()/DAY), 1024*1024*1024, f.now())
  const denied = await f.call(f.receiver, f.base + '/transfer/content', proof)
  assert.equal(denied.status, 429); assert.equal((await denied.json()).error, 'download_limit')
  assert.ok(await f.db.get('SELECT 1 FROM transfer_challenges WHERE id=$1', proof.id))
  assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='download_denied'"))!.n, 1)
  await f.db.run('DELETE FROM download_leases')
  const retry = await f.call(f.receiver, f.base + '/transfer/content', proof)
  assert.equal(retry.status, 200); await retry.body!.cancel()
})

test('partial download cancellation charges only consumed chunks and immediately releases its lease',async t=>{
 const f=await transfer(t,new Uint8Array(128*1024));await f.prepare();assert.equal((await f.upload()).status,200)
 const response=await f.call(f.receiver,f.base+'/transfer/content',await f.prove('download'))
 const reader=response.body!.getReader(),first=await reader.read()
 assert.equal(first.value!.byteLength,64*1024);assert.ok(first.value!.byteLength<f.bytes.byteLength)
 await reader.cancel();reader.releaseLock()
 assert.deepEqual(await f.db.get('SELECT bytes,finished FROM download_leases'),{bytes:first.value!.byteLength,finished:1})
 const retry=await f.call(f.receiver,f.base+'/transfer/content',await f.prove('download'))
 assert.equal(retry.status,200);assert.deepEqual(await retry.arrayBuffer(),f.bytes)
 assert.equal((await f.db.get('SELECT sum(bytes)::bigint AS n FROM download_leases'))!.n,first.value!.byteLength+f.bytes.byteLength)
})

test('lost upload response is recoverable by status and the same reservation after restart without a second commit',async t=>{
 const f=await transfer(t);await f.prepare()
 // Discard the successful response as a disconnected client would.
 const response=await f.upload();assert.equal(response.status,200);await response.body!.cancel()
 const restart=new AuthApi(f.storage.connect(),f.localConfig,fetch,f.now)
 const status=await f.ok(f.sender,f.base+'/uploads/'+f.uploadId,undefined,restart)
 const retry=await f.ok(f.sender,f.base+'/uploads',{operationId:f.uploadId,deviceId:f.identitySender.deviceId,size:f.bytes.byteLength,digest:f.digest,retentionDays:7},restart)
 assert.equal(status.status,'available');assert.equal(retry.status,'available');assert.equal(retry.expiresAt,status.expiresAt)
 assert.deepEqual(await readdir(f.fileStoragePath),[f.uploadId])
 assert.equal((await f.db.get('SELECT count(*) AS n FROM uploads'))!.n,1)
 assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='upload_committed'"))!.n,1)
 assert.equal((await f.db.get('SELECT sum(size)::bigint AS n FROM uploads WHERE deleted_at IS NULL'))!.n,f.bytes.byteLength)
})

test('interrupted request body fails without publishing and allows a new upload reservation after cleanup',async t=>{
 const f=await transfer(t);await f.prepare()
 let first=true
 const body=new ReadableStream({pull(controller){
  if(first){first=false;controller.enqueue(new Uint8Array(f.bytes.slice(0,f.bytes.byteLength/2)))}
  else controller.error(new Error('Connection reset'))
 }},{highWaterMark:0})
 assert.equal((await f.upload(body)).status,503)
 assert.deepEqual(await f.db.get('SELECT status,write_until,ended_at FROM uploads WHERE id=$1',f.uploadId),{status:'failed',write_until:null,ended_at:f.now()})
 assert.equal((await f.ok(f.receiver,f.base)).status,'approved')
 await f.api.prune();assert.deepEqual(await readdir(f.fileStoragePath),[])
 const retry=await f.ok(f.sender,f.base+'/uploads',{operationId:randomUUID(),deviceId:f.identitySender.deviceId,size:f.bytes.byteLength,digest:f.digest,retentionDays:7})
 assert.equal(retry.status,'reserved')
})

test('team reservations share object IDs, concurrent upload limits and exact storage capacity with external shares',async t=>{
 const f=await transfer(t)
 await f.organizations.setPermissions(f.owner.id,f.orgId,f.environment.id,f.sender.id,true,true,true)
 const shareIds=[f.uploadId,randomUUID(),randomUUID()]
 await f.db.run(`INSERT INTO external_shares(id,org_id,environment_id,creator_id,size,digest,retention_days,status,created_at)
  SELECT id,$2,$3,$4,174,$5,1,'reserved',$6 FROM unnest($1::text[]) AS id`,shareIds,f.orgId,f.environment.id,f.sender.id,f.digest,f.now())
 const collision=await f.call(f.sender,f.base+'/uploads',f.reserve)
 assert.equal(collision.status,409);assert.equal((await collision.json()).error,'operation_conflict')
 await f.db.run('UPDATE external_shares SET id=$1 WHERE id=$2',randomUUID(),f.uploadId)
 assert.equal((await f.call(f.sender,f.base+'/uploads',f.reserve)).status,429)
 // Synthetic ended reservations model ciphertext still awaiting deletion, without allocating 512 MiB on disk.
 await f.db.run('DELETE FROM external_shares')
 const pendingIds=Array.from({length:32},()=>randomUUID())
 await f.db.run(`INSERT INTO external_shares(id,org_id,environment_id,creator_id,size,digest,retention_days,status,created_at,ended_at)
  SELECT id,$2,$3,$4,CASE WHEN n=32 THEN 16*1024*1024-$5+1 ELSE 16*1024*1024 END,$6,1,'failed',$7,$7
  FROM unnest($1::text[]) WITH ORDINALITY AS pending(id,n)`,pendingIds,f.orgId,f.environment.id,f.sender.id,f.bytes.byteLength,f.digest,f.now()-600_001)
 assert.equal((await f.call(f.sender,f.base+'/uploads',f.reserve)).status,429)
 await f.db.run('UPDATE external_shares SET size=size-1 WHERE id=$1',pendingIds[31])
 assert.equal((await f.prepare()).status,'reserved')
 assert.equal((await f.db.get('SELECT sum(size)::bigint AS n FROM stored_objects WHERE org_id=$1 AND deleted_at IS NULL',f.orgId))!.n,512*1024*1024)
})

test('permission or device revocation during upload prevents commit, even if permission is regranted',async t=>{
 for(const scenario of ['sender permission','receiver permission','sender device','receiver device'] as const)await t.test(scenario,async t=>{
  const f=await transfer(t);await f.prepare()
  let release!:()=>void,started!:()=>void
  const waiting=new Promise<void>(r=>{release=r}),reading=new Promise<void>(r=>{started=r})
  const stream=new ReadableStream({async pull(controller){started();await waiting;controller.enqueue(new Uint8Array(f.bytes));controller.close()}},{highWaterMark:0})
  const operation=f.upload(stream);await reading
  try{
   if(scenario.endsWith('permission')){
    const user=scenario.startsWith('sender')?f.sender:f.receiver
    await f.organizations.setPermissions(f.owner.id,f.orgId,f.environment.id,user.id,false,false,false)
    await f.organizations.setPermissions(f.owner.id,f.orgId,f.environment.id,user.id,true,true,false)
   }else{
    const sender=scenario.startsWith('sender'),identity=sender?f.identitySender:f.identity
    const auth=sender?{userId:f.sender.id,sessionId:f.sender.hash,reauthenticatedAt:f.now(),active:true}:f.deviceSession()
    const wire=await f.registry.beginAction(auth,'revoke',identity.deviceId,identity.deviceId)
    const key=sender?f.senderSigning:f.signing.privateKey
    await f.registry.complete(auth,wire.challenge.id,await answerDeviceChallenge(wire,wire.challenge,sender?f.senderEncryption:f.encryption,key,f.now()))
   }
   assert.equal((await f.db.get('SELECT status FROM uploads WHERE id=$1',f.uploadId))!.status,'cancelled')
  }finally{release()}
  assert.equal((await operation).status,scenario==='sender device'?403:409)
  await f.api.prune();assert.deepEqual(await readdir(f.fileStoragePath),[])
  assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='upload_committed'"))!.n,0)
 })
})

test('failed physical deletion retains storage usage and retries successfully on maintenance',async t=>{
 const f=await transfer(t);await f.prepare();assert.equal((await f.upload()).status,200)
 await f.ok(f.sender,f.base+'/transfer/revoke',{operationId:randomUUID()})
 const object=join(f.fileStoragePath,f.uploadId),held=object+'.held'
 await rename(object,held);await mkdir(object)
 // unlink cannot remove a directory, even when the test runner has elevated file permissions.
 await f.api.prune()
 assert.equal((await f.db.get('SELECT deleted_at FROM uploads WHERE id=$1',f.uploadId))!.deleted_at,null)
 assert.equal((await f.db.get('SELECT sum(size)::bigint AS n FROM uploads WHERE deleted_at IS NULL'))!.n,f.bytes.byteLength)
 assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='object_delete_failed'"))!.n,1)
 assert.equal((await f.call(f.receiver,f.base+'/transfer/challenge',{action:'download',deviceId:f.identity.deviceId})).status,410)
 await rmdir(object);await rename(held,object);await f.api.prune()
 assert.equal((await f.db.get('SELECT deleted_at FROM uploads WHERE id=$1',f.uploadId))!.deleted_at,f.now())
 assert.equal((await f.db.get('SELECT count(*) AS n FROM uploads WHERE deleted_at IS NULL'))!.n,0)
 assert.deepEqual(await readdir(f.fileStoragePath),[])
})

test('killed upload process leaves no available transfer and restart removes partial ciphertext by the failure deadline',async t=>{
 const f=await transfer(t);await f.prepare();const proof=await f.prove('upload')
 const child=spawn(process.execPath,['--input-type=module','-e',`
  import { Database } from './apps/api/src/database.ts';
  import { AuthApi } from './apps/api/src/auth.ts';
  process.once('message', async input => {
   const db = new Database(process.env.TEST_DATABASE_URL ?? 'postgresql://envhandoff:local-development-only@127.0.0.1:55432/envhandoff_test', input.schema);
   const api = new AuthApi(db, input.config, fetch, () => input.now);
   let first = true;
   const body = new ReadableStream({ async pull(controller) {
    if (first) { first = false; controller.enqueue(new Uint8Array(input.bytes)); return; }
    process.send('partial-written'); await new Promise(() => {});
   } }, { highWaterMark: 0 });
   await api.handle(new Request(input.url, { method: 'POST', headers: input.headers, body, duplex: 'half' }));
  });
 `],{cwd:new URL('../../../',import.meta.url),stdio:['ignore','ignore','inherit','ipc']})
 t.after(()=>{child.kill('SIGKILL')})
 const ready=once(child,'message',{signal:AbortSignal.timeout(10_000)})
 child.send({schema:(await f.db.get('SELECT current_schema() AS name'))!.name,config:f.localConfig,now:f.now(),bytes:Array.from(new Uint8Array(f.bytes.slice(0,f.bytes.byteLength/2))),url:config.apiOrigin+f.path+f.base+'/uploads/'+f.uploadId+'/content',headers:{origin:config.webOrigin,cookie:'envhandoff-dev-session='+f.sender.token,'content-type':'application/octet-stream','x-csrf-token':f.sender.csrf,'x-device-challenge':proof.id,'x-device-proof':proof.proof}})
 assert.equal((await ready)[0],'partial-written')
 const exited=once(child,'exit');child.kill('SIGKILL');await exited
 assert.equal((await f.db.get('SELECT status FROM uploads WHERE id=$1',f.uploadId))!.status,'writing')
 const partial=await readFile(join(f.fileStoragePath,f.uploadId));assert.ok(partial.byteLength>0&&partial.byteLength<f.bytes.byteLength)
 const restart=new AuthApi(f.storage.connect(),f.localConfig,fetch,f.now)
 assert.equal((await f.call(f.receiver,f.base+'/transfer',undefined,restart)).status,403)
 await restart.prune();assert.equal((await readdir(f.fileStoragePath)).length,1)
 await f.advance(60*60_000);await restart.prune()
 assert.equal((await f.db.get('SELECT status FROM uploads WHERE id=$1',f.uploadId))!.status,'failed')
 assert.deepEqual(await readdir(f.fileStoragePath),[])
 assert.equal((await f.db.get('SELECT count(*) AS n FROM uploads WHERE deleted_at IS NULL'))!.n,0)
})
