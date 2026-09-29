import { Database } from './database.ts'

let db: Database | undefined
try {
  db = new Database(process.env.DATABASE_URL ?? '')
  await db.migrate()
  console.log('PostgreSQL schema is up to date')
} catch {
  console.error('Database migration failed. Check DATABASE_URL and PostgreSQL availability.')
  process.exitCode = 1
} finally { await db?.close() }
