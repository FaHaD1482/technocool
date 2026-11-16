import 'server-only';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '@/lib/api';
import { can, type SessionUser } from '@/lib/auth/session';
import { query } from '@/lib/db';

/** Conversations. One thread per client conversation; BOQ sends join the thread of their BOQ number. */
export interface ThreadRow {
  id: string;
  kind: 'general' | 'boq';
  subject: string;
  client_id: string | null;
  owner_user_id: string | null;
  boq_id: string | null;
  boq_no: string | null;
  tag: string;
  gmail_thread_id: string | null;
  last_message_at: Date;
}

/** SQL fragment that limits mail_threads (alias t) to what this user may see. */
export function threadVisibility(u: SessionUser, alias = 't', paramIndex = 1) {
  if (can(u, 'mail.view_all')) return { sql: 'TRUE', params: [] as unknown[] };
  return { sql: `${alias}.owner_user_id = $${paramIndex}`, params: [u.id] as unknown[] };
}

export const threadTag = () => `c-${randomBytes(4).toString('hex')}`;

/** A foreign conversation is indistinguishable from a missing one. */
export async function getVisibleThread(u: SessionUser, id: string): Promise<ThreadRow> {
  if (!z.uuid().safeParse(id).success) throw new ApiError(404, 'Conversation not found.');
  const v = threadVisibility(u, 't', 2);
  const { rows } = await query(
    `SELECT t.id, t.kind, t.subject, t.client_id, t.owner_user_id, t.boq_id, t.boq_no, t.tag, t.gmail_thread_id, t.last_message_at
     FROM mail_threads t WHERE t.id = $1 AND ${v.sql}`, [id, ...v.params]);
  if (!rows[0]) throw new ApiError(404, 'Conversation not found.');
  return rows[0] as ThreadRow;
}

type Sql = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * The conversation for a BOQ number, created on the first send. Keeps every revision in one thread and reuses the
 * BOQ plus-address tag so nothing about reply matching changes.
 */
export async function ensureBoqThread(
  db: Sql,
  p: { boqId: string; boqNo: string; clientId: string | null; ownerId: string; tag: string; subject: string },
): Promise<string> {
  const found = await db.query(`SELECT id FROM mail_threads WHERE kind = 'boq' AND boq_no = $1`, [p.boqNo]);
  if (found.rows[0]) {
    await db.query(
      `UPDATE mail_threads SET boq_id = $2, client_id = coalesce(client_id, $3), last_message_at = now() WHERE id = $1`,
      [found.rows[0].id, p.boqId, p.clientId]);
    return found.rows[0].id as string;
  }
  const { rows } = await db.query(
    `INSERT INTO mail_threads (kind, subject, client_id, owner_user_id, boq_id, boq_no, tag, created_by)
     VALUES ('boq', $1, $2, $3, $4, $5, $6, $3) RETURNING id`,
    [p.subject, p.clientId, p.ownerId, p.boqId, p.boqNo, p.tag]);
  return rows[0].id as string;
}

/** Unread conversations (client replies only, never your own sends) for the rail badge. */
export async function unreadThreadCount(u: SessionUser): Promise<number> {
  const { rows } = await query(
    `SELECT count(DISTINCT n.thread_id)::int AS n FROM notifications n
     JOIN mail_threads t ON t.id = n.thread_id
     WHERE n.user_id = $1 AND n.read_at IS NULL AND n.type = 'message_received'`, [u.id]);
  return rows[0]?.n ?? 0;
}
