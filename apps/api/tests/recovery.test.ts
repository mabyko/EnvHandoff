import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { fixture } from './request-fixture.ts'
import { parseRecoveryArgs, recoveryAccount, recoverManagement, registerRecoveryContact } from '../src/recovery.ts'
import { executeManagementRecovery } from '../src/management-recovery.ts'
import { Deletions } from '../src/deletions.ts'
import { config } from './request-fixture.ts'

test('operator contact registration is explicit, immutable, transactional and dry-run by default',async t=>{
 const f=await fixture(t),input={orgId:f.orgId,contactRef:randomUUID(),caseRef:randomUUID(),contactVerified:true}
 assert.equal((await registerRecoveryContact(f.db,input)).applied,false)
 assert.equal((await f.db.get('SELECT count(*) AS n FROM management_recovery_contacts'))!.n,0)
 assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='recovery_contact_previewed'"))!.n,1)
 await assert.rejects(registerRecoveryContact(f.db,{...input,contactVerified:false,apply:true}),/contact_verification_required/)
 await assert.rejects(registerRecoveryContact(f.db,{...input,contactRef:'private@example.test',apply:true}),/invalid_reference/)
 await assert.rejects(f.db.transaction(async()=>{await registerRecoveryContact(f.db,{...input,apply:true});throw new Error('rollback')}),/rollback/)
 assert.equal((await f.db.get('SELECT count(*) AS n FROM management_recovery_contacts'))!.n,0)
 assert.equal((await registerRecoveryContact(f.db,{...input,apply:true})).alreadyRegistered,false)
 assert.equal((await registerRecoveryContact(f.db,{...input,apply:true})).alreadyRegistered,true)
 await assert.rejects(registerRecoveryContact(f.db,{...input,contactRef:randomUUID(),apply:true}),/contact_already_registered/)
 const event=await f.db.get("SELECT org_id,target_id,event FROM organization_events WHERE event='recovery_contact_registered'")
 assert.deepEqual(event,{org_id:f.orgId,target_id:f.orgId,event:'recovery_contact_registered'})
 await f.db.run('UPDATE organizations SET active=0 WHERE id=$1',f.orgId)
 await assert.rejects(registerRecoveryContact(f.db,{...input,apply:true}),/organization_unavailable/)
})

test('management recovery restores Owner file-operation permissions without rewriting Member grants, keys or other organizations',async t=>{
 const f=await fixture(t),contact={orgId:f.orgId,contactRef:randomUUID(),caseRef:randomUUID(),contactVerified:true,apply:true}
 await registerRecoveryContact(f.db,contact,f.now())
 const otherOrg=randomUUID()
 await f.db.run("INSERT INTO organizations(id,name) VALUES($1,'Other')",otherOrg)
 await f.db.run("INSERT INTO memberships VALUES($1,$2,'owner')",otherOrg,f.owner.id)
 await f.db.run('INSERT INTO oauth_flows VALUES($1,$2,$3,$4,$5)','state','browser','verifier',f.owner.hash,f.now()+60_000)
 await f.db.run('INSERT INTO reauthentications VALUES($1,$2)',f.owner.hash,f.now())
 await f.organizations.issueMember(f.owner.id,f.orgId,f.teamId,{id:'99',login:'future-member'})
 const shareId=randomUUID()
 const reserved=await f.api.handle(new Request(config.apiOrigin+'/organizations/'+f.orgId+'/shares',{method:'POST',headers:{origin:config.webOrigin,cookie:'envhandoff-dev-session='+f.owner.token,'x-csrf-token':f.owner.csrf,'content-type':'application/json'},body:JSON.stringify({operationId:shareId,environmentId:f.environment.id,size:40,digest:randomBytes(32).toString('base64url'),tokenHash:randomBytes(32).toString('base64url'),retentionDays:1})}))
 assert.equal(reserved.status,200)
 const devices=await f.db.all('SELECT * FROM devices ORDER BY id'),grants=await f.db.all('SELECT * FROM environment_permissions ORDER BY user_id'),teams=await f.db.all('SELECT * FROM team_members ORDER BY user_id')
 const input={...contact,caseRef:randomUUID(),target:{id:'2',login:'receiver'},expectedOwners:['1'],allOwnersLost:true}
 const preview=await recoverManagement(f.db,{...input,apply:false},f.now())
 assert.equal(preview.applied,false);assert.equal(preview.sessionsToInvalidate,2);assert.equal(preview.invitationsToCancel,1)
 assert.equal(preview.auditRecorded,true)
 assert.equal(preview.ownerFileAccess,true);assert.equal(preview.restoresDeviceKeys,false)
 assert.equal((await f.db.get('SELECT ended_at FROM external_shares WHERE id=$1',shareId))!.ended_at,null)
 assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='management_recovery_previewed'"))!.n,1)
 assert.ok(await f.db.get('SELECT 1 FROM sessions WHERE token_hash=$1',f.owner.hash))
 assert.equal((await f.db.get("SELECT count(*) AS n FROM invitations WHERE org_id=$1 AND status='pending'",f.orgId))!.n,1)
 assert.equal((await f.db.get('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2',f.orgId,f.owner.id))!.role,'owner')
 await assert.rejects(f.db.transaction(async()=>{await recoverManagement(f.db,input,f.now());throw new Error('rollback')}),/rollback/)
 assert.ok(await f.db.get('SELECT 1 FROM sessions WHERE token_hash=$1',f.owner.hash))
 const [first,retry]=await Promise.all([recoverManagement(f.db,input,f.now()),recoverManagement(f.db,input,f.now())])
 assert.deepEqual([first.replayed,retry.replayed],[false,true])
 assert.ok((await f.db.get('SELECT ended_at FROM external_shares WHERE id=$1',shareId))!.ended_at,'Recovery must revoke access lost by the demoted Owner in the same transaction')
 assert.equal((await f.db.get('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2',f.orgId,f.owner.id))!.role,'member')
 assert.equal((await f.db.get('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2',f.orgId,f.receiver.id))!.role,'owner')
 assert.equal((await f.db.get('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2',otherOrg,f.owner.id))!.role,'owner')
 assert.equal((await f.db.get('SELECT count(*) AS n FROM sessions WHERE user_id=ANY($1::text[])',[f.owner.id,f.receiver.id]))!.n,0)
 assert.ok(await f.db.get('SELECT 1 FROM sessions WHERE token_hash=$1',f.sender.hash))
 assert.equal((await f.db.get('SELECT count(*) AS n FROM oauth_flows'))!.n,0)
 assert.equal((await f.db.get('SELECT count(*) AS n FROM reauthentications'))!.n,0)
 assert.equal((await f.db.get("SELECT count(*) AS n FROM invitations WHERE org_id=$1 AND status='pending'",f.orgId))!.n,0)
 assert.deepEqual(await f.db.all('SELECT * FROM devices ORDER BY id'),devices)
 assert.deepEqual(await f.db.all('SELECT * FROM environment_permissions ORDER BY user_id'),grants)
 assert.deepEqual(await f.db.all('SELECT * FROM team_members ORDER BY user_id'),teams)
 assert.equal((await f.db.get("SELECT count(*) AS n FROM organization_events WHERE event='management_role_recovered'"))!.n,1)
 assert.equal(JSON.stringify(await f.db.all('SELECT * FROM organization_events')).includes(input.contactRef),false)
 assert.equal(JSON.stringify(await f.db.all('SELECT * FROM organization_events')).includes(input.caseRef),false)
 await assert.rejects(recoverManagement(f.db,{...input,target:{id:'3',login:'sender'}}),/recovery_case_conflict/)
 await f.db.run('UPDATE organizations SET active=0 WHERE id=$1',f.orgId)
 await assert.rejects(recoverManagement(f.db,input),/organization_unavailable/)
})

test('recovery rejects stale evidence and replacement Owners gain file-operation rights without restoring dangling grants or device keys',async t=>{
 const f=await fixture(t),contact={orgId:f.orgId,contactRef:randomUUID(),caseRef:randomUUID(),contactVerified:true,apply:true}
 const input={...contact,caseRef:randomUUID(),target:{id:'2',login:'receiver'},expectedOwners:['1'],allOwnersLost:true}
 await assert.rejects(recoverManagement(f.db,input),/registered_contact_required/)
 await registerRecoveryContact(f.db,contact)
 await assert.rejects(recoverManagement(f.db,{...input,contactVerified:false}),/contact_verification_required/)
 await assert.rejects(recoverManagement(f.db,{...input,allOwnersLost:false}),/owner_loss_attestation_required/)
 await assert.rejects(recoverManagement(f.db,{...input,caseRef:contact.caseRef}),/separate_recovery_case_required/)
 await assert.rejects(recoverManagement(f.db,{...input,expectedOwners:['1','1']}),/invalid_owner_list/)
 await assert.rejects(recoverManagement(f.db,{...input,expectedOwners:[]}),/owner_list_changed/)
 await assert.rejects(recoverManagement(f.db,{...input,target:{id:'99',login:'not-yet-signed-in'}}),/target_must_sign_in_first/)
 await f.db.run('UPDATE users SET disabled=1 WHERE id=$1',f.receiver.id)
 await assert.rejects(recoverManagement(f.db,input),/target_must_sign_in_first/)
 const newcomer=randomUUID()
 await f.db.run("INSERT INTO users(id,github_id,login) VALUES($1,'88','replacement')",newcomer)
 // Even inconsistent restored team/grant rows cannot become effective through recovery.
 await f.db.run('INSERT INTO team_members VALUES($1,$2)',f.teamId,newcomer)
 await f.db.run('INSERT INTO environment_permissions VALUES($1,$2,1,1,1)',f.environment.id,newcomer)
 await f.db.run('INSERT INTO project_permissions VALUES($1,$2,1,1,1)',f.project.id,newcomer)
 await recoverManagement(f.db,{...input,target:{id:'88',login:'replacement'}})
 assert.equal((await f.db.get('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2',f.orgId,newcomer))!.role,'owner')
 for(const table of ['team_members','environment_permissions','project_permissions','devices','passkeys','totp_credentials'])assert.equal((await f.db.get('SELECT count(*) AS n FROM '+table+' WHERE user_id=$1',newcomer))!.n,0)
 assert.deepEqual(await f.db.get('SELECT receive,send,external_share FROM effective_file_permissions WHERE user_id=$1',newcomer),{receive:1,send:1,external_share:1})
})

test('recovery includes disabled Owners and never bypasses the organization member limit',async t=>{
 const f=await fixture(t),contact={orgId:f.orgId,contactRef:randomUUID(),caseRef:randomUUID(),contactVerified:true,apply:true}
 await registerRecoveryContact(f.db,contact)
 await f.db.run("UPDATE memberships SET role='owner' WHERE org_id=$1 AND user_id=$2",f.orgId,f.other.id)
 await f.db.run('UPDATE users SET disabled=1 WHERE id=$1',f.other.id)
 const input={...contact,caseRef:randomUUID(),target:{id:'2',login:'receiver'},expectedOwners:['1'],allOwnersLost:true}
 await assert.rejects(recoverManagement(f.db,input),/owner_list_changed/)
 const preview=await recoverManagement(f.db,{...input,expectedOwners:['1','4'],apply:false})
 assert.equal(preview.sessionsToInvalidate,3)
 const newcomer=randomUUID()
 await f.db.run("INSERT INTO users(id,github_id,login) VALUES($1,'88','replacement')",newcomer)
 for(let i=0;i<16;i++) {
  const user=randomUUID()
  await f.db.run('INSERT INTO users(id,github_id,login) VALUES($1,$2,$3)',user,String(100+i),'member-'+i)
  await f.db.run("INSERT INTO memberships VALUES($1,$2,'member')",f.orgId,user)
 }
 await assert.rejects(recoverManagement(f.db,{...input,expectedOwners:['1','4'],target:{id:'88',login:'replacement'}}),/member_limit/)
 assert.equal(await f.db.get('SELECT 1 FROM memberships WHERE org_id=$1 AND user_id=$2',f.orgId,newcomer),undefined)
 await recoverManagement(f.db,{...input,expectedOwners:['1','4']})
 assert.equal((await f.db.get('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2',f.orgId,f.other.id))!.role,'member')
 assert.equal((await f.db.get('SELECT count(*) AS n FROM sessions WHERE user_id=ANY($1::text[])',[f.owner.id,f.receiver.id,f.other.id]))!.n,0)
 assert.equal((await f.db.get('SELECT count(*) AS n FROM memberships WHERE org_id=$1',f.orgId))!.n,20)
})

test('CLI rechecks durable deletions under the recovery lock after checking the GitHub account',async t=>{
 const f=await fixture(t),contact={orgId:f.orgId,contactRef:randomUUID(),caseRef:randomUUID(),contactVerified:true,apply:true}
 await registerRecoveryContact(f.db,contact)
 const ledger=new Deletions(f.localConfig.deletionLedgerPath)
 const args=parseRecoveryArgs(['recover','--org',f.orgId,'--contact-ref',contact.contactRef,'--case-ref',randomUUID(),'--login','receiver','--github-id','2','--owners','1','--attest-contact-verified','--attest-all-owners-lost','--apply'])
 const provider:typeof fetch=async()=>{
  await assert.rejects(f.db.transaction(async()=>{
   await ledger.record('organization',f.orgId,f.now())
   await ledger.sync(f.db,f.now())
   throw new Error('deletion commit failed')
  }),/deletion commit failed/)
  assert.equal((await f.db.get('SELECT active FROM organizations WHERE id=$1',f.orgId))!.active,1)
  return Response.json({id:2,login:'receiver',type:'User'})
 }
 await assert.rejects(executeManagementRecovery(f.db,ledger,args,provider),/organization_unavailable/)
 assert.equal((await f.db.get('SELECT count(*) AS n FROM management_recoveries'))!.n,0)
 assert.equal((await f.db.get('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2',f.orgId,f.receiver.id))!.role,'member')
 await ledger.sync(f.db,f.now())
 assert.equal((await f.db.get('SELECT active FROM organizations WHERE id=$1',f.orgId))!.active,0)
})

test('operator CLI rejects ambiguous arguments and requires numeric provider identity independently of a login name',async()=>{
 const org=randomUUID(),contact=randomUUID(),incident=randomUUID()
 const args=['recover','--org',org,'--contact-ref',contact,'--case-ref',incident,'--login','receiver','--github-id','2','--owners','1','--attest-contact-verified','--attest-all-owners-lost']
 assert.equal(parseRecoveryArgs(args).apply,false)
 assert.equal(parseRecoveryArgs([...args,'--apply']).apply,true)
 for(const extra of [['--apply','--apply'],['--org',org],['--unknown'],['--apply=false']])assert.throws(()=>parseRecoveryArgs([...args,...extra]),/invalid_arguments/)
 assert.throws(()=>parseRecoveryArgs(args.filter(arg=>arg!=='--attest-contact-verified')),/contact_verification_required/)
 assert.throws(()=>parseRecoveryArgs(args.filter(arg=>arg!=='--attest-all-owners-lost')),/owner_loss_attestation_required/)
 const provider:typeof fetch=async()=>Response.json({id:2,login:'receiver',type:'User'})
 assert.deepEqual(await recoveryAccount('receiver','2',provider),{id:'2',login:'receiver'})
 await assert.rejects(recoveryAccount('receiver','3',provider),/github_id_mismatch/)
 await assert.rejects(recoveryAccount('receiver','02',provider),/invalid_github_id/)
 await assert.rejects(recoveryAccount('receiver','2',async()=>Response.json({id:2,login:'receiver',type:'Organization'})),/invalid_github_account/)
})
