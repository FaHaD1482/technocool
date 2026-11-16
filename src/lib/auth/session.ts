import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import { query } from '@/lib/db';

/**
 * Sessions: a random 256-bit token in an httpOnly cookie; the database keeps only its SHA-256.
 * Signing out, an admin disabling a user, or a password reset revokes sessions instantly.
 * Idle sessions end after 12 hours; every session ends after 7 days.
 * Expired rows are cleaned up occasionally (a housekeeping task, never on the request path).
 */
export const SESSION_COOKIE = 'hvac_session';
const MAX_AGE_S = 7 * 24 * 3600;
const IDLE_MS = 12 * 3600 * 1000;
const TOUCH_MS = 5 * 60 * 1000;

let lastPurge = 0;
async function purgeOldSessions() {
  if (Date.now() - lastPurge < 6 * 3600 * 1000) return;
  lastPurge = Date.now();
  await query(`DELETE FROM user_sessions WHERE expires_at < now() - interval '30 days' OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')`).catch(() => {});
}

export type Permission =
  | 'iam.users.view' | 'iam.users.manage' | 'iam.roles.manage'
  | 'settings.company.manage' | 'settings.rates.manage'
  | 'catalog.view' | 'catalog.cost.view' | 'catalog.edit' | 'catalog.price_lists.publish'
  | 'crm.clients.view' | 'crm.clients.create' | 'crm.clients.manage' | 'crm.projects.view' | 'crm.projects.manage'
  | 'boq.view' | 'boq.view_all' | 'boq.create' | 'boq.edit_own' | 'boq.edit_any' | 'boq.delete'
  | 'boq.discount.give' | 'boq.costing.view' | 'boq.approve' | 'boq.export' | 'boq.send'
  | 'mail.unmatched.manage' | 'integrations.gmail.manage' | 'mail.send' | 'mail.view_all' | 'audit.view';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  designation: string | null;
  roles: string[];
  permissions: Set<Permission>;
  sessionId: string;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** HTTPS in production must be explicit: a missing APP_URL must not silently drop `Secure` from the cookie. */
const secureCookies = () => process.env.NODE_ENV === 'production' || (process.env.APP_URL ?? '').startsWith('https://');

export async function clientInfo() {
  const h = await headers();
  const ip = ((h.get('x-forwarded-for') ?? '').split(',')[0] ?? '').trim() || h.get('x-real-ip') || null;
  return { ip: ip && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null, userAgent: h.get('user-agent')?.slice(0, 300) ?? null };
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString('base64url');
  const { ip, userAgent } = await clientInfo();
  void purgeOldSessions();
  await query(
    `INSERT INTO user_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [userId, sha256(token), userAgent, ip, MAX_AGE_S],
  );
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, secure: secureCookies(), sameSite: 'lax', path: '/', maxAge: MAX_AGE_S,
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'signed out'
                 WHERE refresh_token_hash = $1 AND revoked_at IS NULL`, [sha256(token)]);
  }
  jar.delete(SESSION_COOKIE);
}

/** The signed-in user for this request, or null. Cached per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || token.length > 100) return null;
  const { rows } = await query(
    `SELECT s.id AS session_id, s.last_used_at, u.id, u.email, u.full_name, u.designation,
            coalesce(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
            coalesce(array_agg(DISTINCT rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS perms
     FROM user_sessions s
     JOIN app_users u ON u.id = s.user_id AND u.is_active
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
     GROUP BY s.id, u.id`,
    [sha256(token)],
  );
  const r = rows[0];
  if (!r) return null;
  const idle = Date.now() - new Date(r.last_used_at).getTime();
  if (idle > IDLE_MS) {
    await query(`UPDATE user_sessions SET revoked_at = now(), revoked_reason = 'idle' WHERE id = $1`, [r.session_id]);
    return null;
  }
  if (idle > TOUCH_MS) await query('UPDATE user_sessions SET last_used_at = now() WHERE id = $1', [r.session_id]);
  return {
    id: r.id, email: r.email, fullName: r.full_name, designation: r.designation,
    roles: r.roles, permissions: new Set(r.perms), sessionId: r.session_id,
  };
});

export const can = (u: SessionUser | null, p: Permission) => !!u?.permissions.has(p);

/** For pages: signed-in user or redirect to /login. */
export async function requireUser(): Promise<SessionUser> {
  const u = await getCurrentUser();
  if (!u) redirect('/login');
  return u;
}

/** For pages: the permission or a friendly "not allowed" page. */
export async function requirePermission(p: Permission): Promise<SessionUser> {
  const u = await requireUser();
  if (!u.permissions.has(p)) redirect('/forbidden');
  return u;
}
