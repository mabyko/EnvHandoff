import { randomUUID } from 'node:crypto'
import type { TestContext } from 'node:test'
import { Database } from '../src/database.ts'

export async function testDatabase(t: TestContext) {
  const url = process.env.TEST_DATABASE_URL ?? 'postgresql://envhandoff:local-development-only@127.0.0.1:55432/envhandoff_test'
  if (!/^\/[a-z0-9_]+_test$/.test(new URL(url).pathname)) throw new Error('TEST_DATABASE_URL must use a dedicated database ending in _test')
  const schema = 'test_' + randomUUID().replaceAll('-', '')
  const admin = new Database(url), connections: Database[] = []
  const connect = () => {
    const db = new Database(url, schema)
    connections.push(db)
    return db
  }
  t.after(async () => {
    await Promise.all(connections.map(db => db.close()))
    try { await admin.run(`DROP SCHEMA IF EXISTS ${schema} CASCADE`) } finally { await admin.close() }
  })
  await admin.run(`CREATE SCHEMA ${schema}`)
  const initial = connect()
  await initial.migrate()
  await initial.close()
  return { connect }
}
