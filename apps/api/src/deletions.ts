import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Database } from './database.ts'
import { HttpError } from './http.ts'
import { invalidateRequests } from './requests.ts'

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
type Deletion={kind:'user'|'organization';id:string;deletedAt:number}
const unavailable=()=>new HttpError(503,'deletion_ledger_unavailable')

export async function eraseOrganization(db:Database,id:string,at:number,now=Date.now()) {
  const existing=await db.get('SELECT 1 FROM organizations WHERE id=$1 AND active=1',id)
  await db.run("UPDATE organizations SET active=0,name='Deleted organization' WHERE id=$1",id)
  await db.run('DELETE FROM invitations WHERE org_id=$1',id)
  await db.run('DELETE FROM environment_permissions WHERE environment_id IN (SELECT e.id FROM environments e JOIN projects p ON p.id=e.project_id WHERE p.org_id=$1)',id)
  await db.run('DELETE FROM environments WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)',id)
  await db.run('DELETE FROM project_teams WHERE project_id IN (SELECT id FROM projects WHERE org_id=$1)',id)
  await db.run('DELETE FROM projects WHERE org_id=$1',id)
  await db.run('DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE org_id=$1)',id)
  await db.run('DELETE FROM teams WHERE org_id=$1',id)
  await db.run('DELETE FROM memberships WHERE org_id=$1',id)
  await db.run('DELETE FROM management_recovery_contacts WHERE org_id=$1',id)
  await db.run('DELETE FROM management_recoveries WHERE org_id=$1',id)
  await invalidateRequests(db,now)
  if(existing)await db.run("INSERT INTO organization_events(org_id,target_id,event,created_at) VALUES($1,$1,'organization_deleted',$2)",id,at)
}

export async function eraseUser(db:Database,id:string,at:number,now=Date.now()) {
  const existing=await db.get('SELECT github_id FROM users WHERE id=$1',id)
  await db.run('UPDATE users SET disabled=1 WHERE id=$1',id)
  await invalidateRequests(db,now)
  await db.run('DELETE FROM invitations WHERE issuer_id=$1 OR accepted_by=$1 OR target_id=(SELECT github_id FROM users WHERE id=$1)',id)
  await db.run('DELETE FROM oauth_flows WHERE previous_session IN(SELECT token_hash FROM sessions WHERE user_id=$1)',id)
  await db.run('DELETE FROM sessions WHERE user_id=$1',id)
  for(const table of ['passkeys','totp_credentials','security_attempts','device_challenges','device_proofs','devices','team_members','environment_permissions','memberships'])await db.run(`DELETE FROM ${table} WHERE user_id=$1`,id)
  await db.run("UPDATE uploads SET sender_identity='{}' WHERE sender_id=$1",id)
  await db.run("UPDATE uploads SET receiver_identity='{}' WHERE request_id IN(SELECT id FROM file_requests WHERE receiver_id=$1)",id)
  await db.run('DELETE FROM transfer_challenges WHERE upload_id IN(SELECT u.id FROM uploads u JOIN file_requests r ON r.id=u.request_id WHERE r.sender_id=$1 OR r.receiver_id=$1)',id)
  await db.run('DELETE FROM management_recoveries WHERE target_user_id=$1 OR $1=ANY(owner_ids)',id)
  await db.run('DELETE FROM users WHERE id=$1',id)
  if(existing)await db.run("INSERT INTO auth_events(user_id,event,created_at) VALUES($1,'account_deleted',$2)",id,at)
}

// Keep this directory on durable storage independent of DB snapshots; never restore it from an older DB backup.
export class Deletions {
  private readonly root:string
  private readonly durable=new Set<string>()
  constructor(root:string) { this.root=resolve(root) }
  static async initialize(root:string) {
    const ledger=new Deletions(root)
    await mkdir(resolve(ledger.root,'..'),{recursive:true,mode:0o700})
    await mkdir(ledger.root,{mode:0o700})
    await ledger.write('ledger.json',{version:1,id:randomUUID()})
    const parent=await open(resolve(ledger.root,'..'),'r')
    try{await parent.sync()}finally{await parent.close()}
  }
  private async write(name:string,value:unknown) {
    const file=await open(join(this.root,name),'wx',0o600)
    try{await file.writeFile(JSON.stringify(value)+'\n');await file.chmod(0o400);await file.sync()}finally{await file.close()}
    const directory=await open(this.root,'r')
    try{await directory.sync()}finally{await directory.close()}
  }
  private async read(name:string):Promise<Record<string,unknown>> {
    const path=join(this.root,name),stat=await lstat(path)
    if(!stat.isFile() || stat.isSymbolicLink() || stat.size>512)throw unavailable()
    const value:unknown=JSON.parse(await readFile(path,'utf8'))
    if(!value || typeof value!=='object' || Array.isArray(value))throw unavailable()
    return value as Record<string,unknown>
  }
  private async entries() {
    const manifest=await this.read('ledger.json')
    if(manifest.version!==1 || typeof manifest.id!=='string' || !uuid.test(manifest.id) || Object.keys(manifest).sort().join()!=='id,version')throw unavailable()
    const entries:Deletion[]=[]
    for(const file of await readdir(this.root)) {
      if(file==='ledger.json')continue
      const value=await this.read(file)
      if(!['user','organization'].includes(value.kind as string) || typeof value.id!=='string' || !uuid.test(value.id) || !Number.isSafeInteger(value.deletedAt) || (value.deletedAt as number)<0 || Object.keys(value).sort().join()!=='deletedAt,id,kind' || file!==value.kind+'-'+value.id+'.json')throw unavailable()
      entries.push(value as Deletion)
    }
    return {ledgerId:manifest.id,entries}
  }
  async record(kind:Deletion['kind'],id:string,deletedAt:number) {
    if(!uuid.test(id)||!Number.isSafeInteger(deletedAt)||deletedAt<0)throw unavailable()
    try{
      await this.entries()
      const filename=kind+'-'+id+'.json'
      try{await this.write(filename,{kind,id,deletedAt})}catch(error){
        if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error
        const existing=await this.read(filename)
        if(existing.kind!==kind || existing.id!==id || !Number.isSafeInteger(existing.deletedAt))throw unavailable()
        await this.persist(filename)
      }
    }catch{throw unavailable()}
  }
  private async persist(name:string) {
    const file=await open(join(this.root,name),'r')
    try{await file.sync()}finally{await file.close()}
    const directory=await open(this.root,'r')
    try{await directory.sync()}finally{await directory.close()}
  }
  async sync(db:Database,now=Date.now()) {
    try{return await db.transaction(async()=>{
      // ponytail: scan the small-beta deletion ledger on each request; index immutable entries when its size makes this measurable.
      const {ledgerId,entries}=await this.entries()
      for(const file of ['ledger.json',...entries.map(entry=>entry.kind+'-'+entry.id+'.json')])if(!this.durable.has(file)){await this.persist(file);this.durable.add(file)}
      const bound=await db.get<{ledger_id:string}>('SELECT ledger_id FROM deletion_ledger_state WHERE singleton=1')
      if(bound && bound.ledger_id!==ledgerId)throw unavailable()
      const known=await db.all<{kind:string;target_id:string;deleted_at:number}>('SELECT kind,target_id,deleted_at FROM deletion_records')
      const indexed=new Map(entries.map(entry=>[entry.kind+':'+entry.id,entry.deletedAt]))
      for(const row of known)if(indexed.get(row.kind+':'+row.target_id)!==row.deleted_at)throw unavailable()
      if(!bound)await db.run('INSERT INTO deletion_ledger_state VALUES(1,$1)',ledgerId)
      for(const entry of entries) {
        if(entry.kind==='user')await eraseUser(db,entry.id,entry.deletedAt,now)
        else await eraseOrganization(db,entry.id,entry.deletedAt,now)
        await db.run('INSERT INTO deletion_records VALUES($1,$2,$3) ON CONFLICT(kind,target_id) DO NOTHING',entry.kind,entry.id,entry.deletedAt)
      }
      return {organizations:entries.filter(e=>e.kind==='organization').length,users:entries.filter(e=>e.kind==='user').length}
    })}catch{throw unavailable()}
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{
    if(process.argv.slice(2).join(' ')!=='--init'||!process.env.DELETION_LEDGER_PATH)throw unavailable()
    await Deletions.initialize(process.env.DELETION_LEDGER_PATH)
    console.log('Independent deletion ledger initialized. Preserve this volume across database restores.')
  }catch{console.error('Deletion ledger initialization failed. Set DELETION_LEDGER_PATH to a new independent directory; existing ledgers are never overwritten.');process.exitCode=1}
}
