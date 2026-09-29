import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fixture, config } from './request-fixture.ts'
import { AuthApi } from '../src/auth.ts'
import { Deletions } from '../src/deletions.ts'
import { blockRestoredTransfers } from '../src/restore-safe.ts'

function remove(api:AuthApi,user:{token:string;csrf:string},headers:Record<string,string>={}) {
 return api.handle(new Request(config.apiOrigin+'/auth/account/remove',{method:'POST',headers:{origin:config.webOrigin,cookie:'envhandoff-dev-session='+user.token,'x-csrf-token':user.csrf,'content-type':'application/json',...headers},body:'{}'}))
}

test('account deletion requires current-session reauthentication and protects every last active Owner',async t=>{
 const f=await fixture(t)
 assert.equal((await remove(f.api,f.owner)).status,403)
 await f.db.run('INSERT INTO reauthentications VALUES($1,$2)',f.owner.hash,f.now())
 assert.equal((await remove(f.api,f.owner)).status,409)
 await f.db.run("UPDATE memberships SET role='owner' WHERE org_id=$1 AND user_id=$2",f.orgId,f.other.id)
 await f.db.run('UPDATE users SET disabled=1 WHERE id=$1',f.other.id)
 assert.equal((await remove(f.api,f.owner)).status,409)
 assert.deepEqual(await fs.readdir(f.localConfig.deletionLedgerPath),['ledger.json'])
 await f.db.run('UPDATE users SET disabled=0 WHERE id=$1',f.other.id)
 const secondOrg=randomUUID()
 await f.db.run('INSERT INTO organizations(id,name) VALUES($1,$2)',secondOrg,'Other ownership')
 await f.db.run("INSERT INTO memberships VALUES($1,$2,'owner')",secondOrg,f.owner.id)
 assert.equal((await remove(f.api,f.owner)).status,409)
 await f.db.run("INSERT INTO memberships VALUES($1,$2,'owner')",secondOrg,f.other.id)
 assert.equal((await remove(f.api,f.owner,{'x-csrf-token':'bad'})).status,403)
 assert.equal((await remove(f.api,f.owner,{origin:'https://evil.example'})).status,403)
 await f.db.run('UPDATE reauthentications SET verified_at=$1 WHERE session_hash=$2',f.now()-15*60_000,f.owner.hash)
 assert.equal((await remove(f.api,f.owner)).status,403)
 await f.db.run('UPDATE reauthentications SET verified_at=$1 WHERE session_hash=$2',f.now(),f.owner.hash)
 const response=await remove(f.api,f.owner)
 assert.equal(response.status,204);assert.ok(response.headers.getSetCookie().every(cookie=>cookie.includes('Max-Age=0')))
 assert.equal(await f.db.get('SELECT 1 FROM users WHERE id=$1',f.owner.id),undefined)
 assert.ok(await f.db.get('SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2',f.orgId,f.other.id))
})

test('deleting an account removes factors, sessions, devices, invitations and memberships while ending transfers; rejoin gets a fresh identity',async t=>{
 const f=await fixture(t),request=await f.create(),originalUser=await f.db.get<{id:string;github_id:string;login:string;disabled:number}>('SELECT * FROM users WHERE id=$1',f.receiver.id)
 await f.db.run('INSERT INTO reauthentications VALUES($1,$2)',f.receiver.hash,f.now())
 await f.db.run('INSERT INTO passkeys VALUES($1,$2,$3,0,$4,$5)','test-passkey',f.receiver.id,Buffer.from([1]),'fake',f.now())
 await f.db.run('INSERT INTO totp_credentials VALUES($1,$2,0,$3)',f.receiver.id,'fake-encrypted',f.now())
 const invitation=await f.organizations.issueMember(f.owner.id,f.orgId,f.teamId,{id:originalUser!.github_id,login:originalUser!.login})
 const response=await remove(f.api,f.receiver);assert.equal(response.status,204)
 for(const table of ['sessions','passkeys','totp_credentials','devices','device_challenges','device_proofs','memberships','team_members','environment_permissions'])assert.equal((await f.db.get(`SELECT count(*) AS n FROM ${table} WHERE user_id=$1`,f.receiver.id))!.n,0)
 assert.equal(await f.db.get('SELECT 1 FROM invitations WHERE id=$1',invitation.id),undefined)
 assert.equal((await f.db.get('SELECT status FROM file_requests WHERE id=$1',request.id))!.status,'cancelled')
 assert.ok(await f.db.get('SELECT 1 FROM users WHERE id=$1',f.sender.id))
 const record=JSON.parse(await fs.readFile(join(f.localConfig.deletionLedgerPath,'user-'+f.receiver.id+'.json'),'utf8'))
 assert.deepEqual(record,{kind:'user',id:f.receiver.id,deletedAt:f.now()})
 // A later OAuth login may create a new UUID for the same immutable provider ID; old relationships never attach to it.
 const rejoined=randomUUID();await f.db.run('INSERT INTO users(id,github_id,login) VALUES($1,$2,$3)',rejoined,originalUser!.github_id,originalUser!.login)
 await new Deletions(f.localConfig.deletionLedgerPath).sync(f.db,f.now())
 assert.ok(await f.db.get('SELECT 1 FROM users WHERE id=$1',rejoined))
 assert.equal((await f.db.get('SELECT count(*) AS n FROM memberships WHERE user_id=$1',rejoined))!.n,0)
})

test('durable deletion wins a DB rollback and a later metadata restore on normal startup and disaster recovery',async t=>{
 const f=await fixture(t),ledger=new Deletions(f.localConfig.deletionLedgerPath)
 const snapshot=await f.db.get<{id:string;github_id:string;login:string;disabled:number}>('SELECT * FROM users WHERE id=$1',f.sender.id)
 await assert.rejects(f.db.transaction(async()=>{
  await ledger.record('user',f.sender.id,f.now())
  await ledger.sync(f.db,f.now())
  throw new Error('simulate DB commit failure')
 }),/simulate DB commit failure/)
 assert.ok(await f.db.get('SELECT 1 FROM users WHERE id=$1',f.sender.id))
 assert.equal((await f.db.get('SELECT count(*) AS n FROM deletion_records'))!.n,0)
 const restarted=new AuthApi(f.storage.connect(),f.localConfig,fetch,f.now)
 await restarted.prune()
 assert.equal(await f.db.get('SELECT 1 FROM users WHERE id=$1',f.sender.id),undefined)
 // Restore old metadata (including old deletion mirror), while the independent ledger remains current.
 await f.db.run('DELETE FROM deletion_records')
 await f.db.run('INSERT INTO users VALUES($1,$2,$3,$4)',snapshot!.id,snapshot!.github_id,snapshot!.login,snapshot!.disabled)
 await f.db.run("INSERT INTO memberships VALUES($1,$2,'member')",f.orgId,f.sender.id)
 await ledger.sync(f.db,f.now());await blockRestoredTransfers(f.db,true,f.now())
 assert.equal(await f.db.get('SELECT 1 FROM users WHERE id=$1',f.sender.id),undefined)
 assert.equal(await f.db.get('SELECT 1 FROM memberships WHERE user_id=$1',f.sender.id),undefined)
 assert.equal((await f.db.get('SELECT count(*) AS n FROM deletion_records'))!.n,1)
})

test('deleted organizations cannot be resurrected from old DB metadata; other organizations remain usable',async t=>{
 const f=await fixture(t),ledger=new Deletions(f.localConfig.deletionLedgerPath)
 await ledger.record('organization',f.orgId,f.now());await ledger.sync(f.db,f.now())
 await f.db.run("UPDATE organizations SET active=1,name='Restored old name' WHERE id=$1",f.orgId)
 await f.db.run("INSERT INTO memberships VALUES($1,$2,'owner')",f.orgId,f.owner.id)
 await f.db.run('INSERT INTO teams VALUES($1,$2,$3,1)',f.teamId,f.orgId,'Restored')
 await f.db.run('INSERT INTO team_members VALUES($1,$2)',f.teamId,f.owner.id)
 const response=await f.api.handle(new Request(config.apiOrigin+'/organizations',{headers:{origin:config.webOrigin,cookie:'envhandoff-dev-session='+f.owner.token}}))
 assert.equal(response.status,200);assert.deepEqual(await response.json(),[])
 assert.equal((await f.db.get('SELECT active FROM organizations WHERE id=$1',f.orgId))!.active,0)
 assert.equal((await f.db.get('SELECT count(*) AS n FROM teams WHERE org_id=$1',f.orgId))!.n,0)
 assert.ok(await f.db.get('SELECT 1 FROM users WHERE id=$1',f.owner.id))
})

test('missing, replaced, truncated or missing-entry ledgers fail closed without falling back to live DB',async t=>{
 const f=await fixture(t),root=f.localConfig.deletionLedgerPath,ledger=new Deletions(root)
 await ledger.sync(f.db,f.now())
 const missing=new Deletions(root+'-missing');await assert.rejects(missing.sync(f.db),/deletion_ledger_unavailable/)
 const replacement=root+'-replacement';await Deletions.initialize(replacement);t.after(()=>fs.rm(replacement,{recursive:true,force:true}))
 await assert.rejects(new Deletions(replacement).sync(f.db),/deletion_ledger_unavailable/)
 const corrupted=join(root,'user-'+f.sender.id+'.json');await fs.writeFile(corrupted,'{"kind":')
 await assert.rejects(ledger.sync(f.db),/deletion_ledger_unavailable/)
 assert.equal((await f.api.handle(new Request(config.apiOrigin+'/auth/session',{headers:{cookie:'envhandoff-dev-session='+f.owner.token}}))).status,503)
 await fs.unlink(corrupted)
 await ledger.record('user',f.sender.id,f.now());await ledger.sync(f.db,f.now())
 await fs.unlink(corrupted)
 await assert.rejects(ledger.sync(f.db),/deletion_ledger_unavailable/)
})

test('fsync failure never acknowledges deletion, and a complete pending record is reapplied after storage recovers',async t=>{
 const f=await fixture(t),root=f.localConfig.deletionLedgerPath,original=fs.open
 await f.db.run('INSERT INTO reauthentications VALUES($1,$2)',f.sender.hash,f.now())
 t.mock.method(fs,'open',async(...args:Parameters<typeof fs.open>)=>{
  const file=await original(...args)
  if(String(args[0]).endsWith('user-'+f.sender.id+'.json'))t.mock.method(file,'sync',async()=>{throw new Error('simulated fsync failure')})
  return file
 })
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports()})
 assert.equal((await remove(f.api,f.sender)).status,503)
 assert.ok(await f.db.get('SELECT 1 FROM users WHERE id=$1',f.sender.id))
 t.mock.restoreAll();syncBuiltinESMExports()
 await new Deletions(root).sync(f.db,f.now())
 assert.equal(await f.db.get('SELECT 1 FROM users WHERE id=$1',f.sender.id),undefined)
})

test('in-flight authenticated and public requests reapply durable deletion inside their final transaction',async t=>{
 for(const publicRequest of [false,true])await t.test(publicRequest?'public download':'authenticated mutation',async t=>{
  const f=await fixture(t),ledger=new Deletions(f.localConfig.deletionLedgerPath)
  await f.organizations.setPermissions(f.owner.id,f.orgId,f.environment.id,f.sender.id,true,true,true)
  const token='A'.repeat(43),shareId=randomUUID()
  const {createHash}=await import('node:crypto')
  await f.db.run("INSERT INTO external_shares(id,org_id,environment_id,creator_id,size,digest,retention_days,token_hash,status,created_at,available_until) VALUES($1,$2,$3,$4,40,$5,1,$6,'committed',$7,$8)",shareId,f.orgId,f.environment.id,f.sender.id,'a'.repeat(43),createHash('sha256').update(token).digest('base64url'),f.now(),f.now()+86_400_000)
  let release!:()=>void,started!:()=>void
  const gate=new Promise<void>(r=>{release=r}),reading=new Promise<void>(r=>{started=r})
  const body=new ReadableStream<Uint8Array>({async pull(controller){started();await gate;controller.enqueue(new TextEncoder().encode(publicRequest?'{}':JSON.stringify({name:'Must not commit'})));controller.close()}},{highWaterMark:0})
  const path=publicRequest?'/shares/'+shareId+'/content':'/organizations/'+f.orgId+'/teams'
  const request=f.api.handle(new Request(config.apiOrigin+path,{method:'POST',headers:{origin:config.webOrigin,'content-type':'application/json',...(publicRequest?{'x-share-token':token}:{cookie:'envhandoff-dev-session='+f.owner.token,'x-csrf-token':f.owner.csrf})},body,duplex:'half'} as RequestInit))
  await reading
  // The deletion journal survives, while a failed DB commit leaves old live metadata for the blocked request.
  await assert.rejects(f.db.transaction(async()=>{await ledger.record('organization',f.orgId,f.now());throw new Error('failed delete commit')}),/failed delete commit/)
  assert.equal((await f.db.get('SELECT active FROM organizations WHERE id=$1',f.orgId))!.active,1)
  release()
  const response=await request;assert.equal(response.status,404)
  assert.equal((await f.db.get('SELECT count(*) AS n FROM share_download_leases'))!.n,0)
  assert.equal((await f.db.get("SELECT count(*) AS n FROM teams WHERE name='Must not commit'"))!.n,0)
 })
})
