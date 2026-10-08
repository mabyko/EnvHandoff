import { limits } from './limits.ts'
import { Beta } from './beta.ts'
import { createHash } from 'node:crypto'
import { invalidateRequests } from './lifecycle.ts'
import type { Database } from './database.ts'
import { githubAccount } from './organizations.ts'

type Contact = { orgId: string; contactRef: string; caseRef: string; contactVerified: boolean; apply?: boolean }
type Recovery = Contact & { target: { id: string; login: string }; expectedOwners: string[]; allOwnersLost: boolean }
function uuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error('invalid_reference')
  return value
}
function githubId(value: string) {
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('invalid_github_id')
  return value
}
function validate(input: Contact) {
  uuid(input.orgId); uuid(input.contactRef); uuid(input.caseRef)
  if (input.contactVerified !== true) throw new Error('contact_verification_required')
}
async function activeOrganization(db: Database, orgId: string) {
  if (!await db.get('SELECT 1 FROM organizations WHERE id=$1 AND active=1', orgId)) throw new Error('organization_unavailable')
}

// Only the operator CLI calls these functions. No HTTP recovery route is provided.
export async function recoveryAccount(login: string, expectedId: string, fetcher = fetch) {
  githubId(expectedId)
  const account = await githubAccount(login, fetcher)
  if (account.id !== expectedId) throw new Error('github_id_mismatch')
  return account
}

export async function registerRecoveryContact(db: Database, input: Contact, now = Date.now()) {
  validate(input)
  return db.transaction(async () => {
    await activeOrganization(db, input.orgId)
    const prior = await db.get<{ contact_ref: string; case_ref: string }>('SELECT contact_ref,case_ref FROM management_recovery_contacts WHERE org_id=$1', input.orgId)
    if (prior && (prior.contact_ref !== input.contactRef || prior.case_ref !== input.caseRef)) throw new Error('contact_already_registered')
    if (input.apply && !prior) {
      await db.run('INSERT INTO management_recovery_contacts VALUES($1,$2,$3,$4)', input.orgId,input.contactRef,input.caseRef,now)
      await db.run("INSERT INTO organization_events(org_id,target_id,event,created_at) VALUES($1,$1,'recovery_contact_registered',$2)", input.orgId,now)
    } else {
      await db.run('INSERT INTO organization_events(org_id,target_id,event,created_at) VALUES($1,$1,$2,$3)',input.orgId,input.apply?'recovery_contact_checked':'recovery_contact_previewed',now)
    }
    return { applied: !!input.apply, auditRecorded:true, organizationId: input.orgId, alreadyRegistered: !!prior }
  })
}

export async function recoverManagement(db: Database, input: Recovery, now = Date.now()) {
  validate(input); githubId(input.target.id)
  if (!/^[A-Za-z0-9-]{1,39}$/.test(input.target.login)) throw new Error('invalid_github_login')
  if (input.allOwnersLost !== true) throw new Error('owner_loss_attestation_required')
  const expected = input.expectedOwners.map(githubId).sort()
  if (new Set(expected).size !== expected.length) throw new Error('invalid_owner_list')
  return db.transaction(async () => {
    await activeOrganization(db,input.orgId)
    const contact = await db.get<{ contact_ref: string; case_ref: string }>('SELECT contact_ref,case_ref FROM management_recovery_contacts WHERE org_id=$1',input.orgId)
    if (!contact || contact.contact_ref !== input.contactRef) throw new Error('registered_contact_required')
    if (contact.case_ref === input.caseRef) throw new Error('separate_recovery_case_required')
    const target = await db.get<{ id: string }>('SELECT id FROM users WHERE github_id=$1 AND disabled=0',input.target.id)
    if (!target) throw new Error('target_must_sign_in_first')
    const inputHash = createHash('sha256').update(JSON.stringify([input.orgId,input.contactRef,target.id,expected])).digest('hex')
    const prior = await db.get<{ input_hash: string }>('SELECT input_hash FROM management_recoveries WHERE case_ref=$1',input.caseRef)
    if (prior && prior.input_hash !== inputHash) throw new Error('recovery_case_conflict')
    const membership = await db.get<{ role: string }>('SELECT role FROM memberships WHERE org_id=$1 AND user_id=$2',input.orgId,target.id)
    if (prior) {
      await db.run("INSERT INTO organization_events(org_id,target_id,event,created_at) VALUES($1,$1,'management_recovery_checked',$2)",input.orgId,now)
      return { applied: !!input.apply, auditRecorded:true, replayed: true, organizationId:input.orgId,targetUserId:target.id,targetGithubId:input.target.id,targetRole:membership?.role ?? null,
        ownerFileAccess: membership?.role === 'owner', restoresDeviceKeys: false }
    }
    const owners = await db.all<{ id: string; github_id: string }>("SELECT u.id,u.github_id FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1 AND m.role='owner' ORDER BY u.github_id",input.orgId)
    if (JSON.stringify(owners.map(owner=>owner.github_id).sort()) !== JSON.stringify(expected)) throw new Error('owner_list_changed')
    if (!membership && (await db.get<{ n: number }>('SELECT count(*) AS n FROM memberships WHERE org_id=$1',input.orgId))!.n >= limits.organizationMembers) throw new Error('member_limit')
    if (membership?.role !== 'owner') await new Beta(db, () => now).requireCapacity(target.id)
    const users = [...new Set([...owners.map(owner=>owner.id),target.id])]
    const sessions = (await db.get<{ n: number }>('SELECT count(*) AS n FROM sessions WHERE user_id=ANY($1::text[])',users))!.n
    const invitations = (await db.get<{ n: number }>("SELECT count(*) AS n FROM invitations WHERE org_id=$1 AND status='pending'",input.orgId))!.n
    if (input.apply) {
      await db.run('DELETE FROM oauth_flows WHERE previous_session IN (SELECT token_hash FROM sessions WHERE user_id=ANY($1::text[]))',users)
      await db.run('DELETE FROM sessions WHERE user_id=ANY($1::text[])',users)
      await db.run("UPDATE invitations SET status='cancelled' WHERE org_id=$1 AND status='pending'",input.orgId)
      await db.run("UPDATE memberships SET role='member' WHERE org_id=$1 AND role='owner'",input.orgId)
      if (!membership) {
        // Never reactivate dangling grants or team membership when adding a replacement account.
        await db.run('DELETE FROM environment_permissions WHERE user_id=$1 AND environment_id IN (SELECT e.id FROM environments e JOIN projects p ON p.id=e.project_id WHERE p.org_id=$2)',target.id,input.orgId)
        await db.run('DELETE FROM project_permissions WHERE user_id=$1 AND project_id IN (SELECT id FROM projects WHERE org_id=$2)',target.id,input.orgId)
        await db.run('DELETE FROM team_members WHERE user_id=$1 AND team_id IN (SELECT id FROM teams WHERE org_id=$2)',target.id,input.orgId)
      }
      await db.run("INSERT INTO memberships VALUES($1,$2,'owner') ON CONFLICT(org_id,user_id) DO UPDATE SET role='owner'",input.orgId,target.id)
      await invalidateRequests(db,now,{organizationId:input.orgId})
      await db.run('INSERT INTO management_recoveries VALUES($1,$2,$3,$4,$5,$6,$7)',input.caseRef,input.orgId,target.id,input.contactRef,inputHash,owners.map(owner=>owner.id),now)
      await db.run("INSERT INTO organization_events(org_id,target_id,event,created_at) VALUES($1,$2,'management_role_recovered',$3)",input.orgId,target.id,now)
    } else {
      await db.run("INSERT INTO organization_events(org_id,target_id,event,created_at) VALUES($1,$1,'management_recovery_previewed',$2)",input.orgId,now)
    }
    return { applied: !!input.apply,auditRecorded:true,replayed:false,organizationId:input.orgId,targetUserId:target.id,targetGithubId:input.target.id,
      previousOwnerGithubIds:expected,newMembership:!membership,sessionsToInvalidate:sessions,invitationsToCancel:invitations,
      ownerFileAccess: true, restoresDeviceKeys: false }
  })
}

export function parseRecoveryArgs(args: string[]) {
  const mode=args[0]
  if (mode !== 'register-contact' && mode !== 'recover') throw new Error('invalid_arguments')
  const options: Record<string,string|boolean>={}
  const booleans=['apply','attest-contact-verified',...(mode==='recover'?['attest-all-owners-lost']:[])]
  const values=['org','contact-ref','case-ref',...(mode==='recover'?['login','github-id','owners']:[])]
  for (let i=1;i<args.length;i++) {
    const flag=args[i]!.slice(2)
    if (!args[i]!.startsWith('--') || Object.hasOwn(options,flag)) throw new Error('invalid_arguments')
    if (booleans.includes(flag)) options[flag]=true
    else if (values.includes(flag) && args[i+1] && !args[i+1]!.startsWith('--')) options[flag]=args[++i]!
    else throw new Error('invalid_arguments')
  }
  if (values.some(flag=>typeof options[flag]!=='string')) throw new Error('invalid_arguments')
  const contact={orgId:options.org as string,contactRef:options['contact-ref'] as string,caseRef:options['case-ref'] as string,
    contactVerified:options['attest-contact-verified']===true,apply:options.apply===true}
  validate(contact)
  if (mode==='register-contact') return {mode,...contact} as const
  if (!options['attest-all-owners-lost']) throw new Error('owner_loss_attestation_required')
  const expectedOwners=options.owners==='none'?[]:(options.owners as string).split(',').map(githubId)
  githubId(options['github-id'] as string)
  return {mode,...contact,login:options.login as string,githubId:options['github-id'] as string,expectedOwners,allOwnersLost:true} as const
}
