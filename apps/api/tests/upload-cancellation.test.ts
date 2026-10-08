import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TestContext } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { fixture, config, DAY } from './request-fixture.ts'
import { answerDeviceChallenge, deviceIdentity, deviceHash } from '@envhandoff/protocol/device-proof'
import { Shares } from '../src/shares.ts'
import { Transfers } from '../src/transfers.ts'
import { Requests } from '../src/requests.ts'
import { limits } from '../src/limits.ts'

async function setup(t: TestContext, kind: 'share' | 'team') {
  const f = await fixture(t), reservationId = randomUUID(), token = randomBytes(32).toString('base64url')
  const bytes = randomBytes(kind === 'share' ? 40 : 174), digest = createHash('sha256').update(bytes).digest('base64url')
  let requestId = '', deviceId = '', encryption: CryptoKeyPair, signing: CryptoKeyPair
  if (kind === 'share') await f.organizations.setPermissions(f.owner.id, f.orgId, f.environment.id, f.sender.id, true, true, true)
  else {
    encryption = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits'])
    signing = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify'])
    const identity = await deviceIdentity(f.sender.id, randomUUID(), encryption.publicKey, signing.publicKey)
    deviceId = identity.deviceId
    const auth = {userId:f.sender.id,sessionId:f.sender.hash,reauthenticatedAt:f.now(),active:true}
    const wire = await f.registry.beginRegistration(auth,identity)
    await f.registry.complete(auth,wire.challenge.id,await answerDeviceChallenge(wire,wire.challenge,encryption,signing.privateKey,f.now()))
    requestId = (await f.create()).id
    await f.ok(f.sender,'/'+requestId+'/approve',{operationId:randomUUID()})
  }
  const base = '/organizations/'+f.orgId+(kind === 'share' ? '/shares' : '/requests/'+requestId+'/uploads')
  const body = {operationId:reservationId,size:bytes.length,digest,retentionDays:1,...(kind === 'share' ? {environmentId:f.environment.id,tokenHash:createHash('sha256').update(token).digest('base64url')} : {deviceId})}
  const send = (suffix: string, input?: Record<string, unknown>, user = f.sender, api = f.api, headers: Record<string,string> = {}) => api.handle(new Request(config.apiOrigin+base+suffix,{
    method:input?'POST':'GET',headers:{origin:config.webOrigin,cookie:'envhandoff-dev-session='+user.token,'x-csrf-token':user.csrf,...(input?{'content-type':'application/json'}:{}),...headers},body:input?JSON.stringify(input):undefined,
  }))
  const ok = async (suffix: string, input?: Record<string, unknown>, api = f.api) => {
    const response=await send(suffix,input,f.sender,api),value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value
  }
  const cancel = (api = f.api) => ok('/'+reservationId+'/cancel',{operationId:randomUUID()},api)
  const upload = async (data: BodyInit = bytes) => {
    const headers: Record<string,string> = {origin:config.webOrigin,cookie:'envhandoff-dev-session='+f.sender.token,'x-csrf-token':f.sender.csrf,'content-type':'application/octet-stream'}
    if (kind === 'team') {
      const wire=await ok('/'+reservationId+'/challenge',{action:'upload',deviceId})
      const expected={...wire.challenge,sessionHash:await deviceHash(f.sender.hash),scope:{organizationId:f.orgId,requestId,transferId:reservationId,digest}}
      headers['x-device-challenge']=wire.challenge.id
      headers['x-device-proof']=await answerDeviceChallenge(wire,expected,encryption,signing.privateKey,f.now())
    }
    return f.api.handle(new Request(config.apiOrigin+base+'/'+reservationId+'/content',{method:'POST',headers,body:data,duplex:'half'} as RequestInit))
  }
  return {...f,kind,base,body,reservationId,requestId,send,ok,cancel,upload,token,bytes,table:kind==='share'?'external_shares':'uploads'}
}

for (const kind of ['share','team'] as const) {
  test(kind+': cancellation fences a delayed first reservation across connections, survives pruning, and is idempotent',async t=>{
    const f=await setup(t,kind)
    let release!:()=>void
    const wait=new Promise<void>(resolve=>{release=resolve});t.after(()=>release())
    const stream=new ReadableStream({async pull(controller){await wait;controller.enqueue(new TextEncoder().encode(JSON.stringify(f.body)));controller.close()}})
    const late=f.api.handle(new Request(config.apiOrigin+f.base,{method:'POST',headers:{origin:config.webOrigin,cookie:'envhandoff-dev-session='+f.sender.token,'x-csrf-token':f.sender.csrf,'content-type':'application/json'},body:stream,duplex:'half'} as RequestInit))
    assert.equal((await f.send('/'+f.reservationId)).status,404)
    assert.equal((await f.cancel(f.api2)).status,'cancelled')
    release()
    assert.equal((await (await late).json()).status,'cancelled')
    assert.equal((await f.cancel()).status,'cancelled')
    assert.equal((await f.db.get('SELECT count(*) AS n FROM stored_objects WHERE id=$1',f.reservationId))!.n,0)
    assert.equal((await f.db.get('SELECT count(*) AS n FROM upload_cancellations WHERE reservation_id=$1',f.reservationId))!.n,1)
    await f.advance(31*DAY)
    const service=kind==='share'?new Shares(f.db,f.fileStoragePath,f.now):new Transfers(f.db,f.fileStoragePath,f.now)
    await service.prune()
    assert.equal((await f.ok('',f.body,f.api2)).status,'cancelled')
    assert.equal((await f.db.get('SELECT count(*) AS n FROM stored_objects WHERE id=$1',f.reservationId))!.n,0)
  })

  test(kind+': concurrent create/cancel converges, terminal receipt pruning cannot revive a cancelled ID',async t=>{
    const f=await setup(t,kind)
    await Promise.all([f.ok('',f.body),f.cancel(f.api2)])
    assert.equal((await f.cancel()).status,'cancelled')
    await f.advance(31*DAY)
    const service=kind==='share'?new Shares(f.db,f.fileStoragePath,f.now):new Transfers(f.db,f.fileStoragePath,f.now)
    await service.prune()
    assert.equal((await f.db.get('SELECT count(*) AS n FROM stored_objects WHERE id=$1',f.reservationId))!.n,0)
    assert.equal((await f.ok('',f.body,f.api2)).status,'cancelled')
  })

  test(kind+': cancellation while writing prevents commit; cancellation after commit preserves delivery',async t=>{
    const writing=await setup(t,kind);await writing.ok('',writing.body)
    let release!:()=>void
    const wait=new Promise<void>(resolve=>{release=resolve});t.after(()=>release())
    const stream=new ReadableStream({async pull(controller){await wait;controller.enqueue(writing.bytes);controller.close()}})
    const inflight=writing.upload(stream)
    for(let attempt=0;attempt<200;attempt++){
      if((await writing.db.get('SELECT status FROM '+writing.table+' WHERE id=$1',writing.reservationId))?.status==='writing')break
      await new Promise(resolve=>setTimeout(resolve,5))
    }
    assert.equal((await writing.db.get('SELECT status FROM '+writing.table+' WHERE id=$1',writing.reservationId))?.status,'writing')
    assert.equal((await writing.cancel(writing.api2)).status,'cancelled');release()
    assert.equal((await inflight).status,409)
    assert.equal((await writing.db.get('SELECT status FROM '+writing.table+' WHERE id=$1',writing.reservationId))?.status,'cancelled')
    const committed=await setup(t,kind);await committed.ok('',committed.body)
    assert.equal((await committed.upload()).status,200)
    assert.equal((await committed.cancel(committed.api2)).status,'available')
    assert.equal((await committed.db.get('SELECT ended_at FROM '+committed.table+' WHERE id=$1',committed.reservationId))!.ended_at,null)
    if(kind==='share')assert.equal((await committed.db.get('SELECT token_hash FROM external_shares WHERE id=$1',committed.reservationId))!.token_hash,createHash('sha256').update(committed.token).digest('base64url'))
    assert.equal((await committed.db.get('SELECT count(*) AS n FROM upload_cancellations WHERE reservation_id=$1',committed.reservationId))!.n,0)
  })

  test(kind+': cancellation enforces actor/organization/CSRF and remains usable after file permission loss',async t=>{
    const f=await setup(t,kind),suffix='/'+f.reservationId+'/cancel',cancelBody={operationId:randomUUID()}
    assert.equal((await f.send(suffix,cancelBody,f.sender,f.api,{'x-csrf-token':'wrong'})).status,403)
    assert.equal((await f.send(suffix,cancelBody,f.sender,f.api,{origin:'https://foreign.example'})).status,403)
    if(kind==='share') {
      // A member guessing a future ID can fence only their own namespace.
      assert.equal((await f.send(suffix,cancelBody,f.other)).status,200)
      await f.db.run('DELETE FROM memberships WHERE org_id=$1 AND user_id=$2',f.orgId,f.other.id)
      assert.equal((await f.send('/'+randomUUID()+'/cancel',cancelBody,f.other)).status,403)
    } else assert.equal((await f.send(suffix,cancelBody,f.receiver)).status,403)
    assert.equal((await f.ok('',f.body)).status,'reserved')
    assert.notEqual((await f.send(suffix,cancelBody,f.owner)).status,200)
    await f.organizations.setPermissions(f.owner.id,f.orgId,f.environment.id,f.sender.id,false,false,false)
    assert.ok(['cancelled','revoked'].includes((await f.cancel(f.api2)).status))
    assert.equal((await f.db.get('SELECT count(*) AS n FROM upload_cancellations WHERE reservation_id=$1 AND user_id=$2',f.reservationId,f.sender.id))!.n,1)
  })
}

test('absent cancellation is bounded by the shared creation budget; retry never consumes another slot',async t=>{
  const f=await setup(t,'share')
  for(let count=0;count<limits.creationAttempts;count++)assert.equal((await f.ok('/'+randomUUID()+'/cancel',{operationId:randomUUID()})).status,'cancelled')
  assert.equal((await f.send('/'+randomUUID()+'/cancel',{operationId:randomUUID()})).status,429)
  assert.equal((await f.send('',f.body)).status,429)
  const prior=await f.db.get<{reservation_id:string}>('SELECT reservation_id FROM upload_cancellations WHERE user_id=$1 LIMIT 1',f.sender.id)
  assert.equal((await f.ok('/'+prior!.reservation_id+'/cancel',{operationId:randomUUID()})).status,'cancelled')
})

test('team fence survives while its request exists; parent receipt pruning removes it without reviving a late upload',async t=>{
  const f=await setup(t,'team'),requests=new Requests(f.db,f.organizations,f.now)
  await f.cancel()
  await requests.prune()
  assert.ok(await f.db.get('SELECT 1 FROM file_requests WHERE id=$1',f.requestId))
  assert.ok(await f.db.get('SELECT 1 FROM upload_cancellations WHERE reservation_id=$1',f.reservationId))
  await f.ok('',f.body)
  await f.ok('/'+f.reservationId+'/cancel',{operationId:randomUUID()})
  await f.advance(8*DAY);await requests.prune()
  assert.ok(await f.db.get('SELECT 1 FROM file_requests WHERE id=$1',f.requestId))
  assert.ok(await f.db.get('SELECT 1 FROM upload_cancellations WHERE reservation_id=$1',f.reservationId))
  await f.advance(31*DAY);await requests.prune()
  assert.equal(await f.db.get('SELECT 1 FROM file_requests WHERE id=$1',f.requestId),undefined)
  assert.equal(await f.db.get('SELECT 1 FROM upload_cancellations WHERE reservation_id=$1',f.reservationId),undefined)
  assert.equal((await f.send('',f.body,f.sender,f.api2)).status,404)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM stored_objects WHERE id=$1',f.reservationId))!.n,0)
})
