import assert from 'node:assert/strict'
import { test } from 'node:test'
import { testDatabase } from './database.ts'

test('PostgreSQL transactions isolate concurrent callers, roll back failures and rerun migrations safely', async (t) => {
  const fixture = await testDatabase(t), a = fixture.connect(), b = fixture.connect()
  await Promise.all([a.migrate(), b.migrate()])
  assert.equal((await a.get('SELECT count(*) AS n FROM schema_migrations'))!.n, 9)
  await a.run('CREATE TABLE counter (n INTEGER NOT NULL)')
  await a.run('INSERT INTO counter VALUES (0)')
  await assert.rejects(a.transaction(async () => {
    await a.run('UPDATE counter SET n=99')
    throw new Error('rollback')
  }), /rollback/)
  assert.equal((await b.get('SELECT n FROM counter'))!.n, 0)
  const increment = (db: typeof a) => db.transaction(async () => {
    const n = (await db.get('SELECT n FROM counter'))!.n as number
    await db.run('SELECT pg_sleep(0.02)')
    await db.transaction(async () => { await db.run('UPDATE counter SET n=$1', n + 1) })
  })
  await Promise.all([increment(a), increment(a), increment(b)])
  assert.equal((await b.get('SELECT n FROM counter'))!.n, 3)
  const failure = a.transaction(async () => {
    await a.run('UPDATE counter SET n=100')
    await a.run('SELECT pg_sleep(0.02)')
    throw new Error('rollback concurrent')
  })
  const results = await Promise.allSettled([failure, increment(a)])
  assert.deepEqual(results.map(result => result.status), ['rejected', 'fulfilled'])
  assert.equal((await b.get('SELECT n FROM counter'))!.n, 4)
})

test('a timer outliving its transaction opens a fresh transaction and still rolls back',async t=>{
 const fixture=await testDatabase(t),db=fixture.connect()
 let release!:()=>void,finish!:()=>void
 const gate=new Promise<void>(r=>{release=r}),completed=new Promise<void>(r=>{finish=r})
 let failure:unknown
 await db.transaction(async()=>{
  // Real timers preserve AsyncLocalStorage; mocked timers would hide this regression.
  setTimeout(async()=>{
   await gate
   try{await db.transaction(async()=>{
    await db.run('INSERT INTO schema_migrations VALUES (999)')
    throw new Error('rollback delayed callback')
   })}catch(error){failure=error}finally{finish()}
  },0)
 })
 release();await completed
 assert.match(String(failure),/rollback delayed callback/)
 assert.equal(await db.get('SELECT version FROM schema_migrations WHERE version=999'),undefined)
})
