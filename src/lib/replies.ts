import 'server-only';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { ApiError } from '@/lib/api';
import { can, type SessionUser } from '@/lib/auth/session';
import { getVisibleBoq, visibleBoqs } from '@/lib/boq/repo';
import { query, tx } from '@/lib/db';
import { getVisibleThread } from '@/lib/mail/threads';

export interface ReplyFile { n: number; filename: string; mimeType: string; size: number; available: boolean; note?: string }
export interface Reply {
  id: string; boqId: string | null; threadId: string | null; revision: number | null; fromAddr: string; fromName: string | null; subject: string | null;
  bodyText: string; receivedAt: string; matchMethod: string | null; files: ReplyFile[]; unread: boolean;
}

const storageRoot = () => path.resolve(/*turbopackIgnore: true*/ process.env.STORAGE_DIR || './storage');
const isUuid = (v: string) => z.uuid().safeParse(v).success;

function mapFiles(raw: unknown): ReplyFile[] {
  return (Array.isArray(raw) ? raw : []).map((f: any, i: number) => ({
    n: i + 1, filename: String(f.filename ?? `file-${i + 1}`), mimeType: String(f.mimeType ?? 'application/octet-stream'),
    size: Number(f.size ?? 0), available: !!f.path, note: f.skipped,
  }));
}

function mapReply(r: Record<string, any>): Reply {
  return {
    id: r.id, boqId: r.boq_id, threadId: r.thread_id ?? null, revision: r.revision ?? null, fromAddr: r.from_addr, fromName: r.from_name, subject: r.subject,
    bodyText: r.body_text ?? r.snippet ?? '', receivedAt: r.received_at.toISOString(), matchMethod: r.match_method,
    files: mapFiles(r.attachments), unread: !!r.unread,
  };
}

/**
 * Replies to every revision of this BOQ number that the user may see (own-BOQ rule), newest first.
 * `markRead` defaults to true for tests and callers; pages pass false and let the client POST the read-mark,
 * so a prefetch or a GET never changes data.
 */
export async function repliesForBoq(u: SessionUser, boqId: string, opts: { markRead?: boolean } = {}): Promise<Reply[]> {
  const b = await getVisibleBoq(u, boqId);
  const v = visibleBoqs(u, 'b', 3);
  const { rows } = await query(
    `SELECT i.*, b.revision,
            EXISTS (SELECT 1 FROM notifications n WHERE n.inbound_message_id = i.id AND n.user_id = $2 AND n.read_at IS NULL) AS unread
     FROM inbound_messages i JOIN boqs b ON b.id = i.boq_id
     WHERE b.boq_no = $1 AND b.deleted_at IS NULL AND ${v.sql}
     ORDER BY i.received_at DESC LIMIT 200`, [b.boq_no, u.id, ...v.params]);
  if ((opts.markRead ?? true) && rows.some((r) => r.unread)) {
    await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND inbound_message_id = ANY($2::uuid[])`,
      [u.id, rows.map((r) => r.id)]);
  }
  return rows.map(mapReply);
}

/** Reply counts per BOQ for the list page (only BOQs the user sees are asked for). */
export async function replyCounts(u: SessionUser, boqIds: string[]) {
  if (!boqIds.length) return new Map<string, { total: number; unread: number }>();
  const { rows } = await query(
    `SELECT i.boq_id, count(*)::int AS total,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM notifications n WHERE n.inbound_message_id = i.id AND n.user_id = $2 AND n.read_at IS NULL))::int AS unread
     FROM inbound_messages i WHERE i.boq_id = ANY($1::uuid[]) GROUP BY i.boq_id`, [boqIds, u.id]);
  return new Map(rows.map((r) => [r.boq_id as string, { total: r.total as number, unread: r.unread as number }]));
}

// ---------------------------------------------------------------- attachments
export async function readReplyFile(u: SessionUser, replyId: string, n: number) {
  if (!isUuid(replyId) || !Number.isInteger(n) || n < 1) throw new ApiError(404, 'File not found.');
  const { rows } = await query('SELECT boq_id, thread_id, attachments FROM inbound_messages WHERE id = $1', [replyId]);
  const r = rows[0];
  if (!r) throw new ApiError(404, 'File not found.');
  if (r.boq_id) await getVisibleBoq(u, r.boq_id);                                   // own-BOQ rule
  else if (r.thread_id) await getVisibleThread(u, r.thread_id);                     // own-conversation rule
  else if (!can(u, 'mail.unmatched.manage')) throw new ApiError(404, 'File not found.');
  const f = (r.attachments as any[])[n - 1];
  if (!f?.path) throw new ApiError(404, 'File not found.');
  const full = path.resolve(storageRoot(), f.path);
  if (!full.startsWith(storageRoot() + path.sep)) throw new ApiError(404, 'File not found.');
  const buf = await readFile(full).catch(() => { throw new ApiError(410, 'The file is no longer stored.'); });
  return { buf, filename: String(f.filename), mimeType: String(f.mimeType || 'application/octet-stream') };
}

// ---------------------------------------------------------------- unmatched (admin only)
export async function unmatchedReplies(u: SessionUser): Promise<Reply[]> {
  if (!can(u, 'mail.unmatched.manage')) throw new ApiError(403, 'Not allowed.');
  const { rows } = await query(`SELECT i.*, NULL::int AS revision, false AS unread FROM inbound_messages i
                                 WHERE i.boq_id IS NULL AND i.thread_id IS NULL ORDER BY i.received_at DESC LIMIT 200`);
  return rows.map(mapReply);
}

/** Sent BOQs an unmatched reply can be assigned to (latest 300). */
export async function assignableBoqs() {
  const { rows } = await query(`
    SELECT b.id, b.boq_no, b.revision, b.status, p.name AS project, c.name AS client, c.email AS client_email, u.full_name AS owner
    FROM boqs b JOIN projects p ON p.id = b.project_id LEFT JOIN clients c ON c.id = p.client_id LEFT JOIN app_users u ON u.id = b.owner_user_id
    WHERE b.deleted_at IS NULL AND EXISTS (SELECT 1 FROM boq_emails e WHERE e.boq_id = b.id AND e.status = 'sent')
    ORDER BY b.sent_at DESC NULLS LAST LIMIT 300`);
  return rows as { id: string; boq_no: string; revision: number; status: string; project: string; client: string | null; client_email: string | null; owner: string | null }[];
}

export async function assignReply(u: SessionUser, replyId: string, boqId: string) {
  if (!can(u, 'mail.unmatched.manage')) throw new ApiError(403, 'Not allowed.');
  if (!isUuid(replyId) || !isUuid(boqId)) throw new ApiError(400, 'Unknown reply or BOQ.');
  await tx(u.id, async (db) => {
    const b = (await db.query(`SELECT id, boq_no, revision, owner_user_id FROM boqs WHERE id = $1 AND deleted_at IS NULL`, [boqId])).rows[0];
    if (!b) throw new ApiError(404, 'BOQ not found.');
    const email = (await db.query(`SELECT id, thread_id FROM boq_emails WHERE boq_id = $1 AND status = 'sent' ORDER BY sent_at DESC LIMIT 1`, [boqId])).rows[0];
    const r = await db.query(
      `UPDATE inbound_messages SET boq_id = $2, boq_email_id = $3, match_method = 'manual', assigned_to = $4, assigned_by = $5, assigned_at = now(),
              thread_id = coalesce(thread_id, $6)
       WHERE id = $1 AND boq_id IS NULL RETURNING from_name, from_addr, snippet`,
      [replyId, boqId, email?.id ?? null, b.owner_user_id, u.id, email?.thread_id ?? null]);
    if (!r.rowCount) throw new ApiError(409, 'This reply was already assigned.');
    await db.query(`UPDATE notifications SET read_at = now() WHERE inbound_message_id = $1 AND type = 'reply_unmatched' AND read_at IS NULL`, [replyId]);
    if (b.owner_user_id) {
      await db.query(`INSERT INTO notifications (user_id, type, boq_id, inbound_message_id, title, body) VALUES ($1, 'reply_received', $2, $3, $4, $5)`,
        [b.owner_user_id, boqId, replyId, `Reply from ${r.rows[0].from_name ?? r.rows[0].from_addr} on ${b.boq_no} R${b.revision} (assigned by ${u.fullName})`, (r.rows[0].snippet ?? '').slice(0, 200)]);
    }
    await db.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, new_data) VALUES ($1, 'REPLY_ASSIGN', 'inbound_messages', $2, $3)`, [u.id, replyId, { boqId }]);
  });
}

export async function discardReply(u: SessionUser, replyId: string) {
  if (!can(u, 'mail.unmatched.manage')) throw new ApiError(403, 'Not allowed.');
  if (!isUuid(replyId)) throw new ApiError(400, 'Unknown reply.');
  const deleted = await tx(u.id, async (db) => {
    const r = await db.query(`DELETE FROM inbound_messages WHERE id = $1 AND boq_id IS NULL AND thread_id IS NULL RETURNING from_addr`, [replyId]);
    if (r.rowCount) await db.query(`INSERT INTO audit_log (user_id, action, entity, entity_id, new_data) VALUES ($1, 'REPLY_DISCARD', 'inbound_messages', $2, $3)`, [u.id, replyId, { from: r.rows[0].from_addr }]);
    return !!r.rowCount;
  });
  if (deleted) await rm(path.join(storageRoot(), 'inbound', replyId), { recursive: true, force: true });
}

// ---------------------------------------------------------------- notifications
export interface NotificationItem { id: string; type: string; title: string; body: string | null; href: string | null; readAt: string | null; createdAt: string }

export async function unreadCount(userId: string): Promise<number> {
  const { rows } = await query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [userId]);
  return rows[0].n;
}

export async function listNotifications(userId: string, limit = 100): Promise<NotificationItem[]> {
  const { rows } = await query(`SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
  return rows.map((r) => ({
    id: r.id, type: r.type, title: r.title, body: r.body, readAt: r.read_at?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
    href: hrefFor(r),
  }));
}

/** Where a notification points. Computed here (never on the client) so a notification cannot open another site. */
function hrefFor(r: { type: string; boq_id: string | null; thread_id: string | null; inbound_message_id: string | null }): string | null {
  return r.type === 'reply_unmatched' ? '/admin/replies'
    : r.type === 'gmail_disconnected' ? '/admin/gmail'
    : r.thread_id ? `/inbox/${r.thread_id}`
    : r.boq_id ? `/boqs/${r.boq_id}${r.inbound_message_id ? '#replies' : ''}` : null;
}

export async function notificationHref(userId: string, id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  const { rows } = await query(
    `SELECT type, boq_id, thread_id, inbound_message_id FROM notifications WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rows[0] ? hrefFor(rows[0]) : null;
}

/** Marks one (or all, when id is null) of the user's notifications read; returns where to go next. */
export async function markRead(userId: string, id: string | null) {
  if (id === null) { await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [userId]); return; }
  if (!isUuid(id)) return;
  await query(`UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2`, [id, userId]);
}
