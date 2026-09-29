import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, config, DAY } from './request-fixture.ts'
import { createBundle, openBundle } from '../../web/src/lib/bundle.ts'
import { AuthApi } from '../src/auth.ts'

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('base64url')
async function share(t:TestContext) {
  const f=await fixture(t)
  await f.organizations.setPermissions(f.owner.id,f.orgId,f.environment.id,f.sender.id,false,false,true)
  const token=randomBytes(32).toString('base64url'), shareId=randomUUID()
  const original=new Uint8Array([0xef,0xbb,0xbf,65,61,49,13,10])
  const sealed=await createBundle([{file:new File([original],'test.env'),path:'services/test.env'}],'Fake QA','dev')
  const bytes=new Uint8Array(sealed.bytes)
  const body={operationId:shareId,environmentId:f.environment.id,size:bytes.length,digest:hash(bytes),retentionDays:3,tokenHash:hash(token)}
  const path='/organizations/'+f.orgId+'/shares'
  const manage=(user=f.sender,suffix='',input?:Record<string,unknown>)=>f.api.handle(new Request(config.apiOrigin+path+suffix,{method:input?'POST':'GET',headers:{origin:config.webOrigin,cookie:'envhandoff-dev-session='+user.token,'x-csrf-token':user.csrf,...(input?{'content-type':'application/json'}:{})},body:input?JSON.stringify(input):undefined}))
  const ok=async(user=f.sender,suffix='',input?:Record<string,unknown>)=>{const r=await manage(user,suffix,input),b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b}
  const upload=(data:BodyInit=bytes)=>f.api.handle(new Request(config.apiOrigin+path+'/'+shareId+'/content',{method:'POST',headers:{origin:config.webOrigin,cookie:'envhandoff-dev-session='+f.sender.token,'x-csrf-token':f.sender.csrf,'content-type':'application/octet-stream'},body:data,duplex:'half'} as RequestInit))
  const guest=(suffix='',credential=token,target=shareId)=>f.api.handle(new Request(config.apiOrigin+'/shares/'+target+suffix,{method:suffix?'POST':'GET',headers:{origin:config.webOrigin,'x-share-token':credential,...(suffix?{'content-type':'application/json'}:{})},body:suffix?'{}':undefined}))
  const commit=async()=>{await ok(f.sender,'',body);const response=await upload();assert.equal(response.status,200,await response.clone().text());return response.json()}
  return {...f,token,shareId,bytes,body,manage,ok,upload,guest,commit,original,code:sealed.code}
}

test('external permission alone creates share without device; preview never downloads, token survives ACK; ciphertext is opaque',async t=>{
  const f=await share(t)
  assert.equal((await f.manage(f.owner,'',f.body)).status,403)
  assert.equal((await f.manage(f.receiver,'',f.body)).status,403)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM devices WHERE user_id=$1',f.sender.id))!.n,0)
  const [one,two]=await Promise.all([f.ok(f.sender,'',f.body),f.ok(f.sender,'',f.body)]);assert.deepEqual(one,two)
  assert.equal((await f.upload()).status,200)
  const stored=await readFile(join(f.fileStoragePath,f.shareId));assert.deepEqual(stored,Buffer.from(f.bytes));assert.equal(stored.includes(Buffer.from('services/test.env')),false)
  assert.equal((await f.guest()).status,200)
  const info=await (await f.guest()).json();assert.equal(info.project,undefined);assert.equal(info.environment,undefined);assert.equal(info.creatorId,undefined)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM share_download_leases'))!.n,0)
  assert.equal((await f.db.get('SELECT acknowledged_at FROM external_shares WHERE id=$1',f.shareId))!.acknowledged_at,null)
  const download=await f.guest('/content');assert.equal(download.status,200);assert.equal(download.headers.get('cache-control'),'no-store');const ciphertext=await download.arrayBuffer();assert.deepEqual(Buffer.from(ciphertext),Buffer.from(f.bytes))
  const opened=await openBundle(ciphertext,f.code);assert.deepEqual(opened.files[0]!.bytes,f.original)
  await assert.rejects(openBundle(ciphertext,f.token))
  const ack=await (await f.guest('/ack')).json();await f.advance(1000)
  assert.equal((await (await f.guest('/ack')).json()).acknowledgedAt,ack.acknowledgedAt)
  assert.equal((await (await f.guest()).json()).expiresAt,info.expiresAt)
  const again=await f.guest('/content');assert.equal(again.status,200);await again.arrayBuffer()
  assert.equal((await f.db.get('SELECT sum(bytes)::bigint AS n FROM share_download_leases'))!.n,2*f.bytes.length)
  assert.equal((await f.ok(f.other)).shares.length,0)
  assert.equal((await f.ok(f.owner)).shares.length,1)
  assert.equal((await f.manage(f.other,'/'+f.shareId)).status,404)
  assert.equal((await f.db.get('SELECT token_hash FROM external_shares WHERE id=$1',f.shareId))!.token_hash,hash(f.token))
})

test('beta closure preserves external reads and retry lookup but prevents new shares and reserved uploads', async t => {
  const f = await share(t)
  const closed = new AuthApi(f.storage.connect(), { ...f.localConfig, acceptNewTransfers: false }, fetch, f.now)
  const path = config.apiOrigin + '/organizations/' + f.orgId + '/shares'
  const headers = { origin: config.webOrigin, cookie: 'envhandoff-dev-session=' + f.sender.token, 'x-csrf-token': f.sender.csrf, 'content-type': 'application/json' }
  const create = () => closed.handle(new Request(path, { method: 'POST', headers, body: JSON.stringify(f.body) }))
  assert.equal((await create()).status, 503)
  await f.ok(f.sender, '', f.body)
  assert.equal((await create()).status, 200)
  const upload = await closed.handle(new Request(path + '/' + f.shareId + '/content', { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: f.bytes }))
  assert.equal(upload.status, 503)
  assert.equal((await f.upload()).status, 200)
  const download = await closed.handle(new Request(config.apiOrigin + '/shares/' + f.shareId + '/content', { method: 'POST', headers: { origin: config.webOrigin, 'x-share-token': f.token, 'content-type': 'application/json' }, body: '{}' }))
  assert.equal(download.status, 200); assert.deepEqual(new Uint8Array(await download.arrayBuffer()), f.bytes)
  assert.equal(download.headers.get('access-control-expose-headers'), 'Retry-After')
})

test('creator reissue is atomic and retryable; Owner can only revoke and invalid IDs/tokens disclose nothing',async t=>{
  const f=await share(t);const initial=await f.commit()
  const bad=await f.guest('',randomBytes(32).toString('base64url')),missing=await f.guest('',f.token,randomUUID())
  assert.equal(bad.status,404);assert.equal(missing.status,404);assert.deepEqual(await bad.json(),await missing.json())
  const next=randomBytes(32).toString('base64url'), input={operationId:randomUUID(),tokenHash:hash(next)}
  assert.equal((await f.manage(f.owner,'/'+f.shareId+'/reissue',input)).status,403)
  await f.ok(f.sender,'/'+f.shareId+'/reissue',input);await f.ok(f.sender,'/'+f.shareId+'/reissue',input)
  assert.equal((await f.guest()).status,404);assert.equal((await f.guest('',next)).status,200)
  const renewed=await f.ok(f.sender,'/'+f.shareId);assert.equal(renewed.expiresAt,initial.expiresAt);assert.equal(renewed.digest,initial.digest)
  assert.equal((await f.manage(f.sender,'/'+f.shareId+'/reissue',{...input,tokenHash:hash(f.token)})).status,409)
  const revoke={operationId:randomUUID()};await f.ok(f.owner,'/'+f.shareId+'/revoke',revoke);await f.ok(f.owner,'/'+f.shareId+'/revoke',revoke)
  assert.equal((await f.guest('',next)).status,404)
  const ended=await f.ok(f.sender,'/'+f.shareId);assert.equal(ended.status,'revoked');assert.equal(ended.environmentId,undefined);assert.equal(ended.digest,undefined)
  assert.equal((await f.db.get('SELECT token_hash FROM external_shares WHERE id=$1',f.shareId))!.token_hash,null)
  await f.api.prune();assert.deepEqual(await readdir(f.fileStoragePath),[])
})

test('external permission is independent; removal atomically closes shares and regrant cannot reopen them',async t=>{
  const f=await share(t);await f.commit()
  await f.organizations.setPermissions(f.owner.id,f.orgId,f.environment.id,f.sender.id,true,true,true)
  assert.equal((await f.guest()).status,200)
  await f.organizations.setPermissions(f.owner.id,f.orgId,f.environment.id,f.sender.id,false,false,true)
  assert.equal((await f.guest()).status,200)
  await f.organizations.setPermissions(f.owner.id,f.orgId,f.environment.id,f.sender.id,true,true,false)
  assert.equal((await f.db.get('SELECT revoked_at FROM external_shares WHERE id=$1',f.shareId))!.revoked_at,f.now())
  await f.organizations.setPermissions(f.owner.id,f.orgId,f.environment.id,f.sender.id,false,false,true)
  assert.equal((await f.guest()).status,404)
  assert.equal((await f.manage(f.sender,'/'+f.shareId+'/reissue',{operationId:randomUUID(),tokenHash:hash(f.token)})).status,410)
  assert.equal((await f.ok(f.sender,'',f.body)).status,'revoked')
})

test('failed bytes never commit; retention expires, token is deleted and receipts are pruned',async t=>{
  const f=await share(t);await f.ok(f.sender,'',f.body)
  assert.equal((await f.upload(new Uint8Array(f.bytes.length))).status,400)
  assert.equal((await f.ok(f.sender,'/'+f.shareId)).status,'failed')
  assert.equal((await f.guest()).status,404);await f.api.prune();assert.deepEqual(await readdir(f.fileStoragePath),[])
  const g=await share(t);await g.commit();await g.advance(3*DAY)
  assert.equal((await g.guest()).status,404);await g.api.prune()
  assert.equal((await g.ok(g.sender,'/'+g.shareId)).status,'expired');assert.deepEqual(await readdir(g.fileStoragePath),[])
  assert.equal((await g.db.get('SELECT token_hash FROM external_shares WHERE id=$1',g.shareId))!.token_hash,null)
  await g.advance(31*DAY);await g.api.prune();assert.equal((await g.manage(g.sender,'/'+g.shareId)).status,404)
})

test('download reservations enforce shared bytes and concurrency; abort settles only delivered bytes',async t=>{
  const f=await share(t);await f.commit()
  const streams=await Promise.all([f.guest('/content'),f.guest('/content'),f.guest('/content')]);assert.ok(streams.every(r=>r.status===200))
  assert.equal((await f.guest('/content')).status,429)
  await streams[0]!.body!.cancel()
  const retry=await f.guest('/content');assert.equal(retry.status,200);await retry.body!.cancel()
  await Promise.all(streams.slice(1).map(r=>r.body!.cancel()))
  assert.equal((await f.db.get('SELECT sum(bytes)::bigint AS n FROM share_download_leases'))!.n,0)
  await f.db.run('INSERT INTO share_download_leases(id,share_id,org_id,day,bytes,expires_at,finished) VALUES($1,$2,$3,$4,$5,$6,1)',randomUUID(),f.shareId,f.orgId,Math.floor(f.now()/DAY),1024*1024*1024,f.now())
  assert.equal((await f.guest('/content')).status,429)
  assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='share_download_denied' AND target_id=$1",f.shareId))!.n,1)
})

test('external denial audit excludes unknown IDs and secrets, persists after rollback and bounds repeated token failures', async t => {
  const f = await share(t); await f.commit()
  const badToken = randomBytes(32).toString('base64url')
  assert.equal((await f.guest('', badToken)).status, 404)
  assert.equal((await f.guest('/ack', badToken)).status, 404)
  assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='share_download_denied'"))!.n, 0)
  const known = await f.guest('/content', badToken), absent = await f.guest('/content', badToken, randomUUID())
  assert.equal(known.status, 404); assert.equal(absent.status, 404); assert.deepEqual(await known.json(), await absent.json())
  await Promise.all(Array.from({ length: 4 }, () => f.guest('/content', badToken)))
  assert.deepEqual(await f.db.all("SELECT org_id,actor_id,target_id,event,created_at FROM organization_events WHERE event='share_download_denied'"),
    [{ org_id: f.orgId, actor_id: null, target_id: f.shareId, event: 'share_download_denied', created_at: f.now() }])
  assert.equal((await f.db.get('SELECT count(*) AS n FROM share_download_leases'))!.n, 0)
  const events = JSON.stringify(await f.db.all('SELECT * FROM organization_events'))
  for (const secret of [badToken, f.token, hash(f.token), f.code, 'services/test.env']) assert.equal(events.includes(secret), false)
  await f.advance(4 * DAY)
  assert.equal((await f.guest('/content')).status, 404)
  assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='share_download_denied'"))!.n, 2)
})

test('external permission and public rate-limit denials are audited once per target window', async t => {
  const f = await share(t); await f.commit()
  for (let i=0; i<30; i++) assert.equal((await f.guest()).status, 200)
  assert.equal((await f.guest('/content')).status, 429)
  assert.equal((await f.guest('/content')).status, 429)
  assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='share_download_denied'"))!.n, 1)
  await f.advance(60_000)
  await f.organizations.setPermissions(f.owner.id, f.orgId, f.environment.id, f.sender.id, false, false, false)
  assert.equal((await f.guest('/content')).status, 404)
  assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='share_download_denied'"))!.n, 2)
})

test('storage/creation limits combine team requests and external shares, and public CORS requires explicit token header',async t=>{
  const f=await share(t)
  for(let i=0;i<3;i++)await f.ok(f.sender,'',{...f.body,operationId:randomUUID()})
  assert.equal((await f.manage(f.sender,'',f.body)).status,429)
  const preflight=await f.api.handle(new Request(config.apiOrigin+'/shares/'+f.shareId,{method:'OPTIONS',headers:{origin:config.webOrigin,'access-control-request-method':'POST','access-control-request-headers':'x-share-token,content-type'}}))
  assert.equal(preflight.status,204)
  const evil=await f.api.handle(new Request(config.apiOrigin+'/shares/'+f.shareId,{headers:{origin:'https://evil.example','x-share-token':f.token}}));assert.equal(evil.status,403)
  for(let i=0;i<30;i++)assert.equal((await f.guest('',f.token,randomUUID())).status,404)
  const probe=randomUUID();for(let i=0;i<30;i++)await f.guest('',f.token,probe)
  assert.equal((await f.guest('',f.token,probe)).status,429)
})

test('external shares count team reservations and traffic and reject cross-type object IDs',async t=>{
  const f=await share(t), requestId=randomUUID(), uploadId=randomUUID()
  await f.db.run("INSERT INTO file_requests(id,org_id,environment_id,receiver_id,sender_id,receiver_device_id,status,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,'fulfilled',$7,$8)",requestId,f.orgId,f.environment.id,f.receiver.id,f.sender.id,f.identity.deviceId,f.now(),f.now()+DAY)
  const insert=async(id:string,size:number)=>f.db.run("INSERT INTO uploads(id,request_id,org_id,sender_id,sender_device_id,project_id,size,digest,retention_days,status,created_at,ended_at,sender_identity,receiver_identity) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'failed',$9,$9,'{}','{}')",id,requestId,f.orgId,f.sender.id,randomUUID(),f.project.id,size,hash(f.bytes),f.now())
  await insert(uploadId,512)
  assert.equal((await f.manage(f.sender,'',{...f.body,operationId:uploadId})).status,409)
  await f.commit()
  await f.db.run('INSERT INTO download_leases(id,upload_id,org_id,day,bytes,expires_at,finished) VALUES($1,$2,$3,$4,$5,$6,1)',randomUUID(),uploadId,f.orgId,Math.floor(f.now()/DAY),1024*1024*1024,f.now())
  assert.equal((await f.guest('/content')).status,429)
  for(let i=0;i<32;i++)await insert(randomUUID(),16*1024*1024)
  assert.equal((await f.manage(f.sender,'',{...f.body,operationId:randomUUID()})).status,429)
  // Physically pending deletions still occupy storage; pruning removes them before reservation succeeds.
  await f.api.prune()
  assert.equal((await f.manage(f.sender,'',{...f.body,operationId:randomUUID()})).status,429) // creation frequency also includes team attempts
  await f.advance(600_001)
  assert.equal((await f.manage(f.sender,'',{...f.body,operationId:randomUUID()})).status,200)
})

test('revoke during a streaming upload wins atomically, leaves no token and cleanup waits for writer',async t=>{
  const f=await share(t);await f.ok(f.sender,'',f.body)
  let release!:()=>void,started!:()=>void
  const waiting=new Promise<void>(r=>{release=r}),reading=new Promise<void>(r=>{started=r})
  const stream=new ReadableStream({async pull(controller){started();await waiting;controller.enqueue(f.bytes);controller.close()}})
  const uploading=f.upload(stream);await reading
  for(let i=0;i<100;i++){if((await f.db.get('SELECT status FROM external_shares WHERE id=$1',f.shareId))!.status==='writing')break;await new Promise(r=>setTimeout(r,5))}
  await f.ok(f.owner,'/'+f.shareId+'/revoke',{operationId:randomUUID()});await f.api.prune()
  assert.equal((await f.db.get('SELECT deleted_at FROM external_shares WHERE id=$1',f.shareId))!.deleted_at,null)
  release();assert.equal((await uploading).status,409);assert.equal((await f.guest()).status,404)
  await f.api.prune();assert.deepEqual(await readdir(f.fileStoragePath),[])
})
