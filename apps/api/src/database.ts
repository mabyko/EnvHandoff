import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { Pool, types } from 'pg'
import type { PoolClient, QueryResultRow } from 'pg'

export class Database {
  private readonly pool: Pool
  private readonly current = new AsyncLocalStorage<{ client?: PoolClient }>()
  private closing?: Promise<void>

  constructor(url: string, schema = 'public') {
    if (!/^postgres(ql)?:$/.test(new URL(url).protocol)) throw new Error('Set DATABASE_URL to a PostgreSQL connection URL')
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error('Invalid database schema')
    this.pool = new Pool({
      connectionString: url, max: 5, connectionTimeoutMillis: 5000,
      statement_timeout: 15_000, idle_in_transaction_session_timeout: 15_000,
      options: `-c search_path=${schema}`,
      types: { getTypeParser: (oid, format) => oid === 20 ? (value: string) => {
        const number = Number(value)
        if (!Number.isSafeInteger(number)) throw new Error('Database integer exceeds safe range')
        return number
      } : types.getTypeParser(oid, format) },
    })
    this.pool.on('error', () => console.error('PostgreSQL connection failed'))
  }

  async all<T extends QueryResultRow = Record<string, unknown>>(sql: string, ...values: unknown[]): Promise<T[]> {
    return (await (this.current.getStore()?.client ?? this.pool).query<T>(sql, values)).rows
  }
  async get<T extends QueryResultRow = Record<string, unknown>>(sql: string, ...values: unknown[]): Promise<T | undefined> {
    return (await this.all<T>(sql, ...values))[0]
  }
  async run(sql: string, ...values: unknown[]): Promise<{ changes: number }> {
    return { changes: (await (this.current.getStore()?.client ?? this.pool).query(sql, values)).rowCount ?? 0 }
  }
  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.current.getStore()?.client) return operation()
    const client = await this.pool.connect()
    let discard = false
    try {
      await client.query('BEGIN')
      // ponytail: serialize small-beta DB transactions across API instances; use scoped row locks when throughput requires it.
      await client.query('SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext(current_schema()))')
      const context: { client?: PoolClient } = { client }
      let result: T
      // Timers may outlive the transaction; they must not reuse a released client.
      try { result = await this.current.run(context, operation) } finally { context.client = undefined }
      await client.query('COMMIT')
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { discard = true }
      throw error
    } finally { client.release(discard) }
  }
  async migrate(): Promise<void> {
    await this.transaction(async () => {
      await this.run('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)')
      for (const [index, file] of ['001-initial.sql', '002-security.sql', '003-requests.sql', '004-transfers.sql', '005-shares.sql', '006-deletions.sql', '007-management-recovery.sql', '008-download-audit.sql'].entries()) {
        if (await this.get('SELECT version FROM schema_migrations WHERE version=$1', index + 1)) continue
        await this.run(await readFile(new URL('../sql/' + file, import.meta.url), 'utf8'))
        await this.run('INSERT INTO schema_migrations VALUES ($1)', index + 1)
      }
    })
  }
  close(): Promise<void> { return this.closing ??= this.pool.end() }
}
