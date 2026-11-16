'use server';

import { randomBytes } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { hashPassword } from '@/lib/auth/password';
import { can, getCurrentUser } from '@/lib/auth/session';
import { actionError } from '@/lib/action-error';
import { tx } from '@/lib/db';
import { firstIssue } from '@/lib/forms';

export type UserState = { error?: string; ok?: string; password?: string };

/** One-time password: 16 chars from an unambiguous alphabet, shown once to the admin. */
function tempPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(16), (b) => alphabet[b % alphabet.length]).join('').replace(/(.{4})(?!$)/g, '$1-');
}

async function admin() {
  const u = await getCurrentUser();
  if (!u || !can(u, 'iam.users.manage')) throw new Error('You do not have permission to manage users.');
  return u;
}

const Schema = z.object({
  fullName: z.string().trim().min(2, 'Enter the name').max(200),
  email: z.string().trim().toLowerCase().max(200).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'E-mail is not valid'),
  designation: z.string().trim().max(100).optional().transform((v) => v || null),
  role: z.enum(['admin', 'manager', 'estimator', 'viewer']),
});

export async function addUser(_prev: UserState, form: FormData): Promise<UserState> {
  try {
    const u = await admin();
    const p = Schema.safeParse(Object.fromEntries(form.entries()));
    if (!p.success) return { error: firstIssue(p.error) };
    const d = p.data;
    const password = tempPassword();
    const hash = await hashPassword(password);
    const created = await tx(u.id, async (db) => {
      const ex = await db.query('SELECT 1 FROM app_users WHERE email = $1', [d.email]);
      if (ex.rowCount) return false;
      const r = await db.query(
        `INSERT INTO app_users (email, full_name, designation, password_hash, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [d.email, d.fullName, d.designation, hash, u.id]);
      await db.query(`INSERT INTO user_roles (user_id, role_id, granted_by) SELECT $1, id, $2 FROM roles WHERE code = $3`, [r.rows[0].id, u.id, d.role]);
      return true;
    });
    if (!created) return { error: 'A user with that e-mail already exists.' };
    revalidatePath('/admin/users');
    return { ok: `Created ${d.fullName}. Give them this one-time password privately; they should change it after signing in.`, password };
  } catch (e) {
    return { error: actionError(e) };
  }
}

export async function resetPassword(userId: string): Promise<UserState> {
  try {
    const u = await admin();
    if (!z.uuid().safeParse(userId).success) return { error: 'Unknown user.' };
    const password = tempPassword();
    const hash = await hashPassword(password);
    await tx(u.id, async (db) => {
      await db.query(`UPDATE app_users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1`, [userId, hash]);
      await db.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'password reset by admin' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    });
    return { ok: 'New one-time password (their other sessions were signed out):', password };
  } catch (e) {
    return { error: actionError(e) };
  }
}

export async function setActive(userId: string, active: boolean): Promise<UserState> {
  try {
    const u = await admin();
    if (userId === u.id) return { error: 'You cannot disable your own account.' };
    await tx(u.id, async (db) => {
      await db.query('UPDATE app_users SET is_active = $2 WHERE id = $1', [userId, active]);
      if (!active) await db.query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'disabled' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    });
    revalidatePath('/admin/users');
    return { ok: active ? 'User enabled.' : 'User disabled and signed out.' };
  } catch (e) {
    return { error: actionError(e) };
  }
}

export async function changeRole(userId: string, role: string): Promise<UserState> {
  try {
    const u = await admin();
    const r = z.enum(['admin', 'manager', 'estimator', 'viewer']).safeParse(role);
    if (!r.success || !z.uuid().safeParse(userId).success) return { error: 'Unknown role or user.' };
    if (userId === u.id && r.data !== 'admin') return { error: 'You cannot remove your own admin role.' };
    await tx(u.id, async (db) => {
      await db.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
      await db.query(`INSERT INTO user_roles (user_id, role_id, granted_by) SELECT $1, id, $2 FROM roles WHERE code = $3`, [userId, u.id, r.data]);
    });
    revalidatePath('/admin/users');
    return { ok: 'Role changed.' };
  } catch (e) {
    return { error: actionError(e) };
  }
}
