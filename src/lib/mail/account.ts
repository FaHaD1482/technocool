import 'server-only';
import { query, tx } from '@/lib/db';
import { encryptSecret } from './crypto';
import { getOAuthConfig } from './config';

export interface MailStatus {
  configured: boolean;            // Google client id/secret present (saved in the app or in the environment)
  connected: boolean;
  email: string | null;
  status: 'connected' | 'revoked' | 'error' | null;
  detail: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  scopes: string[];
  lastSyncAt: string | null;
}

/** Status only. The token is never selected here, and only the worker decrypts it. */
export async function getMailStatus(): Promise<MailStatus> {
  const { rows } = await query(`
    SELECT m.email, m.status, m.status_detail, m.connected_at, m.scopes, m.last_sync_at, u.full_name
    FROM mail_accounts m LEFT JOIN app_users u ON u.id = m.connected_by WHERE m.id = 1`);
  const r = rows[0];
  return {
    configured: !!(await getOAuthConfig()),
    connected: r?.status === 'connected',
    email: r?.email ?? null, status: r?.status ?? null, detail: r?.status_detail ?? null,
    connectedAt: r?.connected_at?.toISOString() ?? null, connectedBy: r?.full_name ?? null,
    scopes: r?.scopes ?? [], lastSyncAt: r?.last_sync_at?.toISOString() ?? null,
  };
}

export async function saveConnection(userId: string, email: string, refreshToken: string, scopes: string[], historyId: string | null) {
  const enc = encryptSecret(refreshToken);
  await tx(userId, async (db) => {
    await db.query(
      `INSERT INTO mail_accounts (id, email, refresh_token_enc, scopes, status, status_detail, history_id, connected_by, connected_at)
       VALUES (1, $1, $2, $3, 'connected', NULL, $4, $5, now())
       ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, refresh_token_enc = EXCLUDED.refresh_token_enc, scopes = EXCLUDED.scopes,
         status = 'connected', status_detail = NULL, connected_by = EXCLUDED.connected_by, connected_at = now(),
         history_id = CASE WHEN mail_accounts.email = EXCLUDED.email THEN coalesce(mail_accounts.history_id, EXCLUDED.history_id) ELSE EXCLUDED.history_id END`,
      [email, enc, scopes, historyId, userId]);
    await db.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, new_data) VALUES ($1, 'GMAIL_CONNECT', 'mail_accounts', '1', $2)`, [userId, { email, scopes }]);
    // Mail that waited while Gmail was disconnected goes out now.
    await db.query(`UPDATE boq_emails SET not_before = now() WHERE status = 'queued'`);
    await db.query(`UPDATE mail_messages SET not_before = now() WHERE status = 'queued'`);
    await db.query(`SELECT pg_notify('boq_mail', 'reconnected')`);
  });
}

export async function deleteConnection(userId: string): Promise<Buffer | null> {
  return tx(userId, async (db) => {
    const { rows } = await db.query('DELETE FROM mail_accounts WHERE id = 1 RETURNING refresh_token_enc, email');
    await db.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, new_data) VALUES ($1, 'GMAIL_DISCONNECT', 'mail_accounts', '1', $2)`, [userId, { email: rows[0]?.email ?? null }]);
    return rows[0]?.refresh_token_enc ?? null;
  });
}

export const dailyLimit = () => Math.max(1, Number(process.env.MAIL_DAILY_RECIPIENT_LIMIT) || 450);

/** Recipients sent or waiting today (Dhaka day), across BOQ sends and general client mail. */
export async function dailyUsage() {
  const { rows } = await query(`
    SELECT coalesce(sum(n), 0)::int AS n FROM (
      SELECT cardinality(to_addrs) + cardinality(cc_addrs) AS n
      FROM boq_emails
      WHERE status IN ('queued', 'sending', 'sent')
        AND coalesce(sent_at, queued_at) >= (date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka')
      UNION ALL
      SELECT cardinality(to_addrs) + cardinality(cc_addrs)
      FROM mail_messages
      WHERE status IN ('queued', 'sending', 'sent')
        AND coalesce(sent_at, queued_at) >= (date_trunc('day', now() AT TIME ZONE 'Asia/Dhaka') AT TIME ZONE 'Asia/Dhaka')
    ) x`);
  return { used: rows[0].n as number, limit: dailyLimit() };
}
