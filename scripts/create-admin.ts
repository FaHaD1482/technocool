/**
 * Creates (or resets) an administrator and prints a one-time password.
 *   npm run create-admin -- --email boss@company.com --name "Boss Name"
 * The password is shown once; only its argon2id hash is stored. Change it after the first sign-in.
 */
import { randomBytes } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import pg from 'pg';
import { ARGON2_OPTIONS } from '../src/lib/auth/password-options';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  const role = arg('role') ?? 'admin';
  if (!email || !name) {
    console.error('Usage: npm run create-admin -- --email you@company.com --name "Your Name" [--role admin]');
    process.exit(1);
  }
  // Readable but strong: 4 groups of 4 from an unambiguous alphabet (~80 bits).
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  const password = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
  const passwordHash = await hash(password, ARGON2_OPTIONS);

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO app_users (email, full_name, password_hash, email_verified_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_active = true,
         failed_login_count = 0, locked_until = NULL
       RETURNING id`,
      [email, name, passwordHash],
    );
    const userId = rows[0].id;
    const r = await client.query(
      `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2 ON CONFLICT DO NOTHING RETURNING role_id`,
      [userId, role],
    );
    const exists = await client.query('SELECT 1 FROM roles WHERE code = $1', [role]);
    if (!exists.rowCount) throw new Error(`Role "${role}" does not exist`);
    await client.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'password reset' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    await client.query('COMMIT');
    console.log(`\n${r.rowCount ? 'Created' : 'Reset'} ${role}: ${email}`);
    console.log(`One-time password: ${password}`);
    console.log('Sign in at /login, then change it from your account page.\n');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
