import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { testDatabase } from './database.ts'
import { Beta } from '../src/beta.ts'
import { Organizations } from '../src/organizations.ts'
import { AuthApi } from '../src/auth.ts'
import { eraseUser } from '../src/deletions.ts'

const time = 1800000000000
const config = { development: true, apiOrigin: 'http://localhost:3001', webOrigin: 'http://localhost:5173', clientId: 'test', clientSecret: 'test', operatorGithubId: '1' }
test('beta admission is separate from membership; codes and workspace capacity survive concurrent connections', async t => {
  const testDb = await testDatabase(t), db = testDb.connect(), other = testDb.connect()
  let now = time
  const beta = new Beta(db, () => now, '1'), second = new Beta(other, () => now, '1')
  const orgs = new Organizations(db, () => now, undefined, '1'), otherOrgs = new Organizations(other, () => now, undefined, '1')
  const ids: string[] = Array.from({length: 7}, () => randomUUID())
  for (const [index, id] of ids.entries()) await db.run('INSERT INTO users(id,github_id,login) VALUES($1,$2,$3)', id, String(index + 1), 'user' + index)
  const [operator, a, b, c, d, member, outsider] = ids as [string,string,string,string,string,string,string]
  assert.equal((await beta.status(operator)).active, true)
  await assert.rejects(() => beta.issue(a, 'Denied', 1, 7), /operator_required/)
  await assert.rejects(() => orgs.create(a, 'Denied'), /beta_required/)
  for (const [count, days] of [[0,1],[1,0],[1.5,7],[1001,7],[1,366]]) await assert.rejects(() => beta.issue(operator, 'Invalid', count, days), /invalid_beta_code/)
  const code = await beta.issue(operator, 'One place', 1, 7)
  const results = await Promise.allSettled([beta.redeem(a, code.code), second.redeem(b, code.code)])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const winner = results[0]!.status === 'fulfilled' ? a : b
  await beta.redeem(winner, code.code)
  assert.equal((await beta.codes(operator))[0]!.used, 1)
  assert.equal(JSON.stringify(await db.all('SELECT * FROM beta_codes')).includes(code.code.replaceAll('-', '')), false)
  assert.equal(JSON.stringify(await beta.codes(operator)).includes('code_hash'), false)
  const first = await orgs.create(winner, 'First')
  const creates = await Promise.allSettled([orgs.create(winner, 'Second'), otherOrgs.create(winner, 'Third')])
  assert.equal(creates.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal((await beta.status(winner)).owned, 2)
  const opening = await orgs.issueOwner({id: String(ids.indexOf(winner) + 1), login: 'winner'})
  await assert.rejects(() => orgs.accept(winner, opening.token, 'Bypass'), /workspace_limit/)
  const operatorOrg = await orgs.create(operator, 'Operator')
  const team = (await orgs.detail(operator, operatorOrg.id)).teams[0]!.id as string
  const invitation = await orgs.issueMember(operator, operatorOrg.id, team, {id: '6', login: 'member'})
  await orgs.accept(member, invitation.token)
  await orgs.setRole(operator, operatorOrg.id, member, 'owner')
  assert.equal((await beta.status(member)).active, false)
  await assert.rejects(() => orgs.create(member, 'Still denied'), /beta_required/)
  const winnerInvite = await orgs.issueMember(operator, operatorOrg.id, team, {id: String(ids.indexOf(winner) + 1), login: 'winner'})
  await orgs.accept(winner, winnerInvite.token)
  await assert.rejects(() => orgs.transferOwner(operator, operatorOrg.id, winner), /workspace_limit/)
  assert.equal((await orgs.detail(operator, operatorOrg.id)).role, 'owner')
  assert.equal((await beta.status(winner)).owned, 2)
  const expiring = await beta.issue(operator, 'Expiring', 2, 1)
  await beta.redeem(c, expiring.code.toLowerCase())
  now += 86400000
  await assert.rejects(() => beta.redeem(d, expiring.code), /beta_code_unavailable/)
  assert.equal((await beta.status(c)).active, true)
  const revoked = await beta.issue(operator, 'Revoke', 2, 7)
  await beta.redeem(d, revoked.code)
  await beta.revoke(operator, revoked.id)
  await assert.rejects(() => beta.redeem(outsider, revoked.code), /beta_code_unavailable/)
  assert.equal((await beta.status(d)).active, true)
  await db.run('UPDATE users SET disabled=1 WHERE id=$1', outsider)
  await assert.rejects(() => beta.redeem(outsider, code.code), /session_expired/)
  await eraseUser(db, c, now, now)
  assert.equal(await db.get('SELECT 1 FROM beta_members WHERE user_id=$1', c), undefined)
  assert.equal((await db.get('SELECT used FROM beta_codes WHERE id=$1', expiring.id))!.used, 1)
  assert.equal((await orgs.detail(winner, first.id)).role, 'owner')
})

test('beta HTTP denies non-operators, requires recent verification and CSRF, counts failed attempts', async t => {
  const testDb = await testDatabase(t), db = testDb.connect(), api = new AuthApi(db, config, fetch, () => time)
  const users = []
  for (let n = 1; n <= 2; n++) {
    const id = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url')
    const hash = createHash('sha256').update(token).digest('base64url')
    await db.run('INSERT INTO users(id,github_id,login) VALUES($1,$2,$3)', id, String(n), 'user' + n)
    await db.run('INSERT INTO sessions VALUES($1,$2,$3,$4,$4)', hash, id, csrf, time)
    users.push({id,token,csrf,hash})
  }
  const [operator, member] = users
  const request = (path: string, user = operator!, body?: unknown, headers = {}) => api.handle(new Request(config.apiOrigin + path, {method: body === undefined ? 'GET' : 'POST', headers: {origin: config.webOrigin, cookie: 'envhandoff-dev-session=' + user.token, 'x-csrf-token': user.csrf, 'content-type':'application/json', ...headers}, body: body === undefined ? undefined : JSON.stringify(body)}))
  assert.equal((await request('/beta/codes', member)).status, 403)
  assert.equal((await request('/beta/codes', member, {label:'Denied',maxUses:1,days:7})).status, 403)
  assert.equal((await request('/beta/codes', operator, {label:'Needs verification',maxUses:1,days:7})).status, 403)
  await db.run('INSERT INTO reauthentications VALUES($1,$2)', operator!.hash, time)
  assert.equal((await request('/beta/codes', operator, {label:'CSRF',maxUses:1,days:7}, {'x-csrf-token':''})).status, 403)
  assert.equal((await request('/beta/codes', operator, {label:'Origin',maxUses:1,days:7}, {origin:'https://evil.example'})).status, 403)
  const issued = await request('/beta/codes', operator, {label:'Group',maxUses:2,days:7})
  assert.equal(issued.status, 200)
  const result = await issued.json()
  assert.equal((await request('/beta/redeem', member, {code: result.code, operator: true})).status, 400)
  for (let i = 0; i < 19; i++) assert.equal((await request('/beta/redeem', member, {code:'bad'})).status, 400)
  assert.equal((await request('/beta/redeem', member, {code:result.code})).status, 429)
  assert.equal((await new Beta(db, () => time, '1').status(member!.id)).active, false)
  assert.equal((await request('/organizations', operator, {name:'Operator workspace'})).status, 200)
  assert.equal((await request('/organizations', member, {name:'Denied'})).status, 403)
  assert.equal((await request('/beta', operator, undefined, {cookie:''})).status, 401)
  assert.equal((await request('/beta/codes/revoke', operator, {id:result.id})).status, 200)
})

test('migration preserves explicitly admitted legacy owners without activating ordinary members', async t => {
  const testDb = await testDatabase(t), db = testDb.connect()
  await db.run('DROP TABLE beta_members,beta_codes')
  await db.run('DELETE FROM schema_migrations WHERE version=9')
  const owner = randomUUID(), member = randomUUID(), org = randomUUID()
  await db.run("INSERT INTO users(id,github_id,login) VALUES($1,'10','legacy'),($2,'11','member')", owner, member)
  await db.run('INSERT INTO organizations(id,name) VALUES($1,$2)', org, 'Existing team')
  await db.run("INSERT INTO memberships VALUES($1,$2,'owner'),($1,$3,'member')", org, owner, member)
  await db.run("INSERT INTO invitations(id,token_hash,kind,target_id,target_login,status,created_at,expires_at,accepted_by) VALUES($1,$2,'owner','10','legacy','accepted',$3,$4,$5)", randomUUID(), 'test-only', time, time + 1, owner)
  await db.migrate(); await db.migrate()
  const beta = new Beta(db, () => time)
  assert.equal((await beta.status(owner)).active, true)
  assert.equal((await beta.status(owner)).owned, 1)
  assert.equal((await beta.status(member)).active, false)
  assert.equal((await beta.status(member)).operator, false)
})
