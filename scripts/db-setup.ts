/**
 * Creates the database (if missing) and runs every db/NN_*.sql file once, in order.
 * Applied files are recorded in schema_migrations with a checksum, so running it again is safe.
 *
 *   npm run db:setup          back up, create, migrate
 *   npm run db:setup -- --status    show what is applied (no writes)
 *   npm run db:setup -- --no-backup skip the pre-migration dump (small/throwaway databases)
 *   npm run db:setup -- --force     continue even if an applied file changed since it was run
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const DB_DIR = path.resolve(import.meta.dirname, '..', 'db');
const statusOnly = process.argv.includes('--status');
const force = process.argv.includes('--force');
const noBackup = process.argv.includes('--no-backup');

function need(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`Missing ${name} in .env.local`); process.exit(1); }
  return v;
}

/** A dump outside the project (a dump inside the repo is a secret leak: it holds hashes and tokens). */
function backup(databaseUrl: string) {
  if (noBackup) { console.log('Skipping the backup (--no-backup).'); return; }
  const dir = process.env.BACKUP_DIR || path.resolve(import.meta.dirname, '..', '..', 'technocool-backups');
  mkdirSync(dir, { recursive: true });
  const dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `${dbName}-${stamp}.dump`);
  const r = spawnSync('pg_dump', ['-Fc', '--no-owner', `--dbname=${databaseUrl}`, '-f', file], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    console.error(`pg_dump failed: ${r.error?.message ?? r.stderr?.trim()}\n` +
      'Add the PostgreSQL bin folder to PATH, or run with --no-backup if this database is disposable.');
    process.exit(1);
  }
  console.log(`Backup: ${file}`);
}

async function ensureDatabase(databaseUrl: string, adminUrl: string) {
  const dbName = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!/^[a-z_][a-z0-9_]*$/.test(dbName)) throw new Error(`Unsafe database name: ${dbName}`);
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rowCount) { console.log(`Database ${dbName} exists.`); return; }
    await admin.query(`CREATE DATABASE ${dbName} ENCODING 'UTF8' TEMPLATE template0`);
    console.log(`Created database ${dbName}.`);
  } finally {
    await admin.end();
  }
}

async function main() {
  const databaseUrl = need('DATABASE_URL');
  if (!statusOnly) await ensureDatabase(databaseUrl, need('DB_ADMIN_URL'));
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const hasSchema = (await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations'`)).rowCount;
    if (!statusOnly && hasSchema) backup(databaseUrl);

    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Map<string, string>(
      (await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map((r) => [r.filename, r.checksum]),
    );
    const files = readdirSync(DB_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    const drifted: string[] = [];

    for (const file of files) {
      const sql = readFileSync(path.join(DB_DIR, file), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
      const prev = applied.get(file);
      if (prev) {
        if (prev === sum) { console.log(`  ✓ ${file}  applied`); continue; }
        drifted.push(file);
        console.log(`  ✗ ${file}  applied, but the file has CHANGED since (write a new numbered file instead)`);
        continue;
      }
      if (statusOnly) { console.log(`  · ${file}  pending`); continue; }
      process.stdout.write(`  → ${file} ... `);
      // Each file manages its own BEGIN/COMMIT, so a failure leaves nothing half-done.
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, sum]);
      console.log('done');
    }

    if (drifted.length) {
      console.error(`\n${drifted.length} applied migration(s) were edited: ${drifted.join(', ')}`);
      if (force) console.error('Continuing because --force was given.');
      else { console.error('Refusing to continue. Restore the file, or rerun with --force.'); process.exitCode = 1; return; }
    }

    if (!statusOnly) {
      const { rows } = await client.query(`SELECT
        (SELECT count(*) FROM roles) AS roles, (SELECT count(*) FROM permissions) AS permissions,
        (SELECT count(*) FROM products) AS products, (SELECT count(*) FROM app_users) AS users`);
      console.log('\nLoaded:', rows[0]);
      if (Number(rows[0].users) === 0) {
        console.log('\nNo users yet. Create the first administrator:\n  npm run create-admin -- --email you@company.com --name "Your Name"');
      }
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  if (err.position) console.error('at character', err.position);
  process.exit(1);
});
