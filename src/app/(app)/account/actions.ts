'use server';

import { z } from 'zod';
import { hashPassword, passwordProblem, verifyPassword } from '@/lib/auth/password';
import { getCurrentUser } from '@/lib/auth/session';
import { query, tx } from '@/lib/db';

export type PwState = { error?: string; ok?: string };

export async function changePassword(_prev: PwState, form: FormData): Promise<PwState> {
  const u = await getCurrentUser();
  if (!u) return { error: 'Please sign in again.' };
  const p = z.object({ current: z.string().max(200), next: z.string().max(200), confirm: z.string().max(200) }).safeParse(Object.fromEntries(form.entries()));
  if (!p.success) return { error: 'Fill in all three fields.' };
  const { current, next, confirm } = p.data;
  if (next !== confirm) return { error: 'The new passwords do not match.' };
  const problem = passwordProblem(next);
  if (problem) return { error: problem };
  const { rows } = await query('SELECT password_hash FROM app_users WHERE id = $1', [u.id]);
  if (!(await verifyPassword(rows[0]?.password_hash ?? null, current))) return { error: 'Your current password is not right.' };
  const hash = await hashPassword(next);
  await tx(u.id, async (db) => {
    await db.query('UPDATE app_users SET password_hash = $2 WHERE id = $1', [u.id, hash]);
    // Sign out every other device; keep this one.
    await db.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'password changed'
                    WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [u.id, u.sessionId]);
  });
  return { ok: 'Password changed. Other devices were signed out.' };
}
