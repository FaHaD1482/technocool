'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { verifyPassword } from '@/lib/auth/password';
import { clientInfo, createSession } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { safeInternalPath } from '@/lib/safe-path';

const MAX_FAILS = 5;          // per account before the app_users lock (15 min)
const LOCK_MIN = 15;
const EMAIL_FAILS = 10;       // per e-mail in 15 min across all IPs
const IP_FAILS = 30;          // per IP in 15 min
const GLOBAL_FAILS = 300;     // whole site, slows a distributed attempt without hurting one office
const WINDOW_MIN = 15;

/**
 * Throttling lives in the database (login_attempts), so it survives a restart and is shared by every instance.
 * The per-IP counter trusts X-Forwarded-For / X-Real-IP; put the app behind a proxy that overwrites them.
 */
async function loginLimited(ip: string | null, email: string): Promise<boolean> {
  const { rows } = await query(
    `SELECT
       count(*) FILTER (WHERE email = $2)::int AS email_fails,
       count(*) FILTER (WHERE ip = $1)::int    AS ip_fails,
       count(*)::int                           AS global_fails
     FROM login_attempts
     WHERE ok = false AND created_at > now() - make_interval(mins => $3)`,
    [ip, email, WINDOW_MIN]);
  const r = rows[0];
  return r.email_fails >= EMAIL_FAILS || r.ip_fails >= IP_FAILS || r.global_fails >= GLOBAL_FAILS;
}

async function recordAttempt(ip: string | null, email: string, ok: boolean) {
  await query(`INSERT INTO login_attempts (ip, email, ok) VALUES ($1, $2, $3)`, [ip, email, ok]);
  // Keep the table small; an occasional prune is enough.
  if (Math.random() < 0.05) await query(`DELETE FROM login_attempts WHERE created_at < now() - interval '7 days'`);
}

const Schema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200), next: z.string().max(500).optional() });
export type LoginState = { error?: string; email?: string };

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const parsed = Schema.safeParse({ email: form.get('email'), password: form.get('password'), next: form.get('next') || undefined });
  if (!parsed.success) return { error: 'Enter your e-mail and password.', email: String(form.get('email') ?? '') };
  const { email, password, next } = parsed.data;
  const { ip, userAgent } = await clientInfo();

  // Same wording whether the account exists or not.
  if (await loginLimited(ip, email)) return { error: 'Too many attempts. Wait a few minutes and try again.', email };

  const { rows } = await query(
    `SELECT id, password_hash, is_active, locked_until, failed_login_count FROM app_users WHERE email = $1`, [email]);
  const u = rows[0];
  if (u?.locked_until && new Date(u.locked_until) > new Date()) {
    await recordAttempt(ip, email, false);
    return { error: `This account is locked after too many wrong passwords. Try again after ${new Date(u.locked_until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}, or ask the admin.`, email };
  }
  const ok = await verifyPassword(u?.password_hash ?? null, password);
  const audit = (action: string, userId: string | null) => query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, ip_address, user_agent, new_data) VALUES ($1::uuid, $2, 'app_users', $1::text, $3, $4, $5)`,
    [userId, action, ip, userAgent, { email }]);

  if (!u || !ok || !u.is_active) {
    await recordAttempt(ip, email, false);
    if (u) {
      await query(`UPDATE app_users SET failed_login_count = failed_login_count + 1,
                     locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) END
                   WHERE id = $1`, [u.id, MAX_FAILS, LOCK_MIN]);
      await audit('LOGIN_FAILED', u.id);
    }
    return { error: 'That e-mail and password do not match.', email };
  }

  await query(`UPDATE app_users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [u.id]);
  await audit('LOGIN', u.id);
  await recordAttempt(ip, email, true);
  // A successful sign-in clears the failed tries for this address so one typo does not count towards the limit.
  await query(`DELETE FROM login_attempts WHERE email = $1 AND ok = false`, [email]);
  await createSession(u.id);
  // Only a same-site path: `//host` and `/\host` (which browsers normalise to a different site) are rejected.
  redirect(safeInternalPath(next));
}
