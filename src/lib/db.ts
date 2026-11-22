import 'server-only';
import pg from 'pg';

// numeric -> string (exact; the calc module parses it as a decimal). int8 -> number is safe for counts.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

const globalForPg = globalThis as unknown as { __pgPool?: pg.Pool };

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set: copy .env.example to .env.local and fill in the database password.');
}

export const pool =
  globalForPg.__pgPool ??
  new pg.Pool({
    connectionString,
    // More users at once → raise DB_POOL_MAX (keep it under Postgres' max_connections minus the worker's).
    max: Math.min(Math.max(Number(process.env.DB_POOL_MAX) || 10, 2), 100),
    idleTimeoutMillis: 30_000,
    // Fail fast instead of piling up requests when every connection is busy.
    connectionTimeoutMillis: 10_000,
    // A runaway query is cancelled instead of holding a connection forever.
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 30_000,
    application_name: 'hvac-boq-web',
  });
if (process.env.NODE_ENV !== 'production') globalForPg.__pgPool = pool;

export type Db = pg.PoolClient;

/** A query outside a transaction (reads that need no audit user). */
export async function query<T extends pg.QueryResultRow = any>(text: string, params?: unknown[]) {
  return pool.query<T>(text, params as any[]);
}

/**
 * Run fn in one transaction with the acting user set (SET LOCAL app.user_id), so audit_log,
 * boq_status_history and updated_by know who did it. Rolls back on any error.
 */
export async function tx<T>(userId: string | null, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (userId) await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** True when a Postgres error came from the "sent BOQ is locked" triggers. */
export const isLockedError = (e: unknown) => (e as { hint?: string })?.hint === 'boq_locked';
