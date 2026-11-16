/**
 * Safety rail for the database tests. They truncate tables, delete the Gmail connection and consume document
 * numbers, so they must never run against the live database by accident.
 *
 *   TEST_DATABASE_URL   required; must differ from DATABASE_URL
 *   TEST_DB_NAME        optional; defaults to the database in TEST_DATABASE_URL and must end in `_test`
 */
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import pg from 'pg';

try { loadEnvFile('.env.local'); } catch { /* CI passes env vars directly */ }

const url = process.env.TEST_DATABASE_URL;
const live = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    'TEST_DATABASE_URL is not set. The database tests delete data, so they refuse to guess.\n' +
    '  Create a throwaway database, e.g. createdb hvac_boq_test\n' +
    '  and add to .env.local:  TEST_DATABASE_URL=postgres://postgres:PASSWORD@localhost:5432/hvac_boq_test',
  );
}
if (live && url === live) {
  throw new Error('TEST_DATABASE_URL must not be the same database as DATABASE_URL.');
}

const dbName = process.env.TEST_DB_NAME || new URL(url).pathname.replace(/^\//, '');
if (!/_test$/i.test(dbName)) {
  throw new Error(`The test database must be named *_test (got "${dbName}"). Refusing to run.`);
}

/** Runs once before the suite: the test database must be migrated, and it gets a marker row proving what it is. */
export async function ensureTestDb() {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rowCount } = await client.query(`SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'boqs'`);
    if (!rowCount) {
      throw new Error(
        `The test database "${dbName}" has no schema yet.\n` +
        `  DATABASE_URL=$TEST_DATABASE_URL npm run db:setup`,
      );
    }
    // A marker that a human can see in DBeaver: this database may be wiped.
    await client.query(`CREATE TABLE IF NOT EXISTS test_safety (
      id smallint PRIMARY KEY CHECK (id = 1),
      note text NOT NULL DEFAULT 'Automated-test database: it may be wiped at any time.')
    `).catch(() => {});
    await client.query(`INSERT INTO test_safety (id) VALUES (1) ON CONFLICT (id) DO NOTHING`).catch(() => {});
  } finally {
    await client.end();
  }
}

/** Where the DB tests write files; kept out of the real storage folder. */
export const testStorageDir = path.resolve(import.meta.dirname, '..', '..', '.test-storage');

process.env.DATABASE_URL = url;
process.env.STORAGE_DIR = testStorageDir;

export default async function setup() {
  await ensureTestDb();
}
