import 'server-only';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { ApiError } from '@/lib/api';
import { can, type SessionUser } from '@/lib/auth/session';
import { query, tx } from '@/lib/db';
import { assertClientSafeFile } from '@/lib/excel/safety';
import { likePattern } from '@/lib/paging';
import { dailyUsage, getMailStatus } from './account';
import { ALLOWED_LABEL, MAX_FILES, MAX_FILE_BYTES, attachmentDir, newMessageId, readStoredAttachment, storeAttachments, validateStored, type StoredAttachment, type UploadFile } from './attachments';
import { messageIdFor, parseRecipients, plusAddress } from './compose';
import { getVisibleThread, threadTag, threadVisibility, type ThreadRow } from './threads';

const noBreak = (s: string) => !/[\r\n]/.test(s);

export const ComposeSchema = z.object({
  clientId: z.string().uuid('Choose a client'),
  to: z.string().max(1000),
  cc: z.string().max(1000).default(''),
  subject: z.string().trim().min(3, 'Enter a subject').max(250).refine(noBreak, 'The subject must be one line'),
  body: z.string().trim().min(1, 'Write a message').max(20000),
  threadId: z.string().uuid().optional(),
  replyToInboundId: z.string().uuid().optional(),
});
export type ComposeInput = z.infer<typeof ComposeSchema>;

export interface ComposePreflight {
  blockers: string[];
  warnings: string[];
  mailbox: string | null;
  to: string;
  client: { id: string; name: string; contactPerson: string | null; email: string | null };
  limits: { maxFiles: number; maxFileMb: number; allowed: string };
}

export async function composePreflight(u: SessionUser, clientId: string): Promise<ComposePreflight> {
  const [{ rows }, mail, daily] = await Promise.all([
    query(`SELECT id, name, contact_person, email FROM clients WHERE id = $1 AND deleted_at IS NULL`, [clientId]),
    getMailStatus(),
    dailyUsage(),
  ]);
  const c = rows[0];
  if (!c) throw new ApiError(404, 'Client not found.');

  const blockers: string[] = [];
  if (!can(u, 'mail.send')) blockers.push('Your role cannot write to clients.');
  if (!mail.configured) blockers.push('Gmail is not set up on the server yet. Ask the admin to fill in the Google client on the Gmail page.');
  else if (!mail.connected) blockers.push(mail.status === 'revoked' ? 'Gmail was disconnected. Ask the admin to reconnect it.' : 'The company Gmail is not connected yet. Ask the admin to connect it.');
  if (daily.used >= daily.limit) blockers.push(`Today's sending limit is reached (${daily.used} of ${daily.limit} recipients). Try again tomorrow.`);

  const warnings: string[] = [];
  if (!c.email) warnings.push('This client has no e-mail saved. Type the address below.');
  if (daily.used >= daily.limit * 0.8) warnings.push(`Near today's sending limit: ${daily.used} of ${daily.limit} recipients used.`);

  return {
    blockers,
    warnings,
    mailbox: mail.email,
    to: c.email ?? '',
    client: { id: c.id, name: c.name, contactPerson: c.contact_person ?? null, email: c.email ?? null },
    limits: { maxFiles: MAX_FILES, maxFileMb: Math.round(MAX_FILE_BYTES / 1024 / 1024), allowed: ALLOWED_LABEL },
  };
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Costing never leaves the company by e-mail: refuse any workbook that carries the internal sheet. */
async function assertNoCostingSheet(stored: StoredAttachment[]) {
  for (const a of stored) {
    if (a.mimeType !== XLSX_MIME) continue;
    const buf = await readStoredAttachment(a.path);
    try {
      await assertClientSafeFile(buf);
    } catch (e) {
      throw new ApiError(400, `“${a.filename}” cannot be sent: ${(e as Error).message}`);
    }
  }
}

export interface QueuedMessage { messageId: string; threadId: string; subject: string }

/**
 * Queues a general/official message, or a reply inside an existing conversation. The worker sends it.
 * Order: validate → resolve the conversation → store attachments → insert the row + notify the worker.
 */
export async function queueMessage(u: SessionUser, input: ComposeInput, files: UploadFile[] = []): Promise<QueuedMessage> {
  if (!can(u, 'mail.send')) throw new ApiError(403, 'Your role cannot write to clients.');

  const to = parseRecipients(input.to), cc = parseRecipients(input.cc ?? '');
  if (to.bad.length || cc.bad.length) throw new ApiError(400, `Not a valid e-mail address: ${[...to.bad, ...cc.bad].join(', ')}`);
  if (!to.ok.length) throw new ApiError(400, 'Add at least one recipient.');
  if (to.ok.length > 10 || cc.ok.length > 10) throw new ApiError(400, 'At most 10 addresses in To and 10 in Cc.');

  const [{ rows }, mail] = await Promise.all([
    query(`SELECT id, name, email FROM clients WHERE id = $1 AND deleted_at IS NULL`, [input.clientId]),
    getMailStatus(),
  ]);
  const client = rows[0];
  if (!client) throw new ApiError(404, 'Client not found.');
  if (!mail.configured) throw new ApiError(409, 'Gmail is not set up on the server yet.', 'mail_blocked');
  if (!mail.connected || !mail.email) throw new ApiError(409, 'The company Gmail is not connected. Ask the admin to reconnect it.', 'mail_blocked');
  const mailbox = mail.email;

  const daily = await dailyUsage();
  if (daily.used + to.ok.length + cc.ok.length > daily.limit) throw new ApiError(409, 'This would go over today\'s sending limit.', 'mail_blocked');
  if ([...to.ok, ...cc.ok].includes(mailbox.toLowerCase())) throw new ApiError(400, 'Do not send to the company mailbox itself.');

  // Conversation: reply into an existing thread, or start a new one.
  let thread: ThreadRow | null = null;
  let inReplyTo: string | null = null;
  let references: string | null = null;
  if (input.replyToInboundId) {
    const { rows: inb } = await query(
      `SELECT thread_id, rfc_message_id, references_hdr FROM inbound_messages WHERE id = $1`, [input.replyToInboundId]);
    if (!inb[0]?.thread_id) throw new ApiError(400, 'That message is not part of a conversation yet.');
    thread = await getVisibleThread(u, inb[0].thread_id);
    inReplyTo = inb[0].rfc_message_id ?? null;
    references = [inb[0].references_hdr, inb[0].rfc_message_id].filter(Boolean).join(' ') || null;
  } else if (input.threadId) {
    thread = await getVisibleThread(u, input.threadId);
  }

  const subject = thread && !/^re:/i.test(input.subject) ? `Re: ${input.subject}` : input.subject;
  const messageId = newMessageId();
  let stored: StoredAttachment[] = [];
  try {
    stored = await storeAttachments(messageId, files);
  } catch (e) {
    throw new ApiError(400, (e as Error).message);
  }

  try {
    await assertNoCostingSheet(stored);
    return await tx(u.id, async (db) => {
      let t = thread;
      if (!t) {
        const { rows: made } = await db.query(
          `INSERT INTO mail_threads (kind, subject, client_id, owner_user_id, tag, created_by)
           VALUES ('general', $1, $2, $3, $4, $3) RETURNING id, kind, subject, client_id, owner_user_id, boq_id, boq_no, tag, gmail_thread_id, last_message_at`,
          [input.subject, client.id, u.id, threadTag()]);
        t = made[0] as ThreadRow;
      }
      await db.query(
        `INSERT INTO mail_messages (id, thread_id, sent_by, client_id, to_addrs, cc_addrs, subject, body_text, attachments,
                                    reply_to, rfc_message_id, in_reply_to, references_hdr, from_addr, gmail_thread_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [messageId, t.id, u.id, client.id, to.ok, cc.ok, subject, input.body, JSON.stringify(stored),
          plusAddress(mailbox, t.tag), messageIdFor(t.tag), inReplyTo, references, mailbox, t.gmail_thread_id]);
      await db.query(`UPDATE mail_threads SET last_message_at = now(), subject = CASE WHEN kind = 'general' THEN $2 ELSE subject END WHERE id = $1`,
        [t.id, subject]);
      await db.query(`SELECT pg_notify('boq_mail', $1)`, [messageId]);
      return { messageId, threadId: t.id, subject };
    });
  } catch (e) {
    await rm(attachmentDir(messageId), { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

export interface ThreadSummary {
  id: string; kind: 'general' | 'boq'; subject: string; clientId: string | null; clientName: string | null;
  clientEmail: string | null; boqId: string | null; boqNo: string | null; lastMessageAt: string;
  replies: number; unread: boolean;
  /** For the Gmail-style list: start of the newest message, total messages, any attachment. */
  snippet: string; messages: number; hasFiles: boolean; lastDirection: 'in' | 'out' | null;
}

/** Collapses whitespace and quoted reply lines so the list preview reads like Gmail's one-line snippet. */
function toSnippet(body: string | null): string {
  if (!body) return '';
  const lines = body.split(/\r?\n/);
  const cut = lines.findIndex((l) => l.startsWith('>'));
  const text = (cut > 0 ? lines.slice(0, cut) : lines).join(' ').replace(/\s+/g, ' ').trim();
  // Gmail's quote header ("On Mon, Nov 9, 2026 at 3:00 PM … wrote:") can wrap over lines; cut at its start.
  const quote = text.search(/\bOn \S.{0,200}? wrote:/);
  return (quote > 0 ? text.slice(0, quote).trim() : text).slice(0, 160);
}

type ThreadFilter = 'all' | 'unread' | 'boq' | 'general';

/** WHERE clause shared by the list and its count. $1 is always the caller (used by the unread check). */
function threadWhere(u: SessionUser, opts: { filter?: ThreadFilter; q?: string }) {
  const params: unknown[] = [u.id];
  const v = threadVisibility(u, 't', 2);
  params.push(...v.params);
  // `$1` must appear (and be typed) even when no clause needs the caller, e.g. an admin's unfiltered count.
  const where = ['$1::uuid IS NOT NULL', v.sql];
  if (opts.filter === 'boq') where.push(`t.kind = 'boq'`);
  if (opts.filter === 'general') where.push(`t.kind = 'general'`);
  if (opts.filter === 'unread') {
    where.push(`EXISTS (SELECT 1 FROM notifications n WHERE n.thread_id = t.id AND n.user_id = $1 AND n.read_at IS NULL AND n.type = 'message_received')`);
  }
  const q = (opts.q ?? '').trim().slice(0, 100);
  if (q) {
    params.push(likePattern(q));
    where.push(`(t.subject ILIKE $${params.length} OR c.name ILIKE $${params.length} OR c.email ILIKE $${params.length})`);
  }
  return { params, sql: `FROM mail_threads t LEFT JOIN clients c ON c.id = t.client_id WHERE ${where.join(' AND ')}` };
}

/** How many conversations match (for "1–50 of 312"). */
export async function countThreadsForUser(u: SessionUser, opts: { filter?: ThreadFilter; q?: string } = {}): Promise<number> {
  const w = threadWhere(u, opts);
  const { rows } = await query(`SELECT count(*)::int AS n ${w.sql}`, w.params);
  return rows[0]?.n ?? 0;
}

export async function threadsForUser(
  u: SessionUser,
  opts: { filter?: ThreadFilter; q?: string; take?: number; offset?: number } = {},
): Promise<ThreadSummary[]> {
  const w = threadWhere(u, opts);
  const params = w.params;
  const take = Math.min(Math.max(opts.take ?? 50, 1), 300);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  // Pick the page of ids first (index on last_message_at), then compute snippet / counts only for those rows.
  const { rows } = await query(
    `SELECT t.id, t.kind, t.subject, t.client_id, t.boq_id, t.boq_no, t.last_message_at,
            c.name AS client_name, c.email AS client_email,
            (SELECT count(*)::int FROM inbound_messages i WHERE i.thread_id = t.id) AS replies,
            EXISTS (SELECT 1 FROM notifications n WHERE n.thread_id = t.id AND n.user_id = $1 AND n.read_at IS NULL AND n.type = 'message_received') AS unread,
            last.body_text AS last_body, last.dir AS last_dir,
            ((SELECT count(*) FROM inbound_messages i WHERE i.thread_id = t.id)
             + (SELECT count(*) FROM mail_messages m WHERE m.thread_id = t.id)
             + (SELECT count(*) FROM boq_emails b WHERE b.thread_id = t.id))::int AS messages,
            (EXISTS (SELECT 1 FROM inbound_messages i WHERE i.thread_id = t.id AND jsonb_array_length(coalesce(i.attachments, '[]'::jsonb)) > 0)
             OR EXISTS (SELECT 1 FROM mail_messages m WHERE m.thread_id = t.id AND jsonb_array_length(coalesce(m.attachments, '[]'::jsonb)) > 0)
             OR EXISTS (SELECT 1 FROM boq_emails b WHERE b.thread_id = t.id AND cardinality(b.export_ids) > 0)) AS has_files
     FROM (SELECT t.id ${w.sql} ORDER BY t.last_message_at DESC, t.id LIMIT ${take} OFFSET ${offset}) pick
     JOIN mail_threads t ON t.id = pick.id
     LEFT JOIN clients c ON c.id = t.client_id
     LEFT JOIN LATERAL (
       SELECT x.body_text, x.dir FROM (
         SELECT i.body_text, 'in' AS dir, i.received_at AS at FROM inbound_messages i WHERE i.thread_id = t.id
         UNION ALL SELECT m.body_text, 'out', coalesce(m.sent_at, m.queued_at) FROM mail_messages m WHERE m.thread_id = t.id
         UNION ALL SELECT b.body_text, 'out', coalesce(b.sent_at, b.queued_at) FROM boq_emails b WHERE b.thread_id = t.id
       ) x ORDER BY x.at DESC NULLS LAST LIMIT 1
     ) last ON true
     ORDER BY t.last_message_at DESC, t.id`, params);

  return rows.map((r) => ({
    id: r.id, kind: r.kind, subject: r.subject, clientId: r.client_id, clientName: r.client_name,
    clientEmail: r.client_email, boqId: r.boq_id, boqNo: r.boq_no,
    lastMessageAt: (r.last_message_at as Date).toISOString(), replies: r.replies, unread: r.unread,
    snippet: toSnippet(r.last_body), messages: r.messages, hasFiles: r.has_files, lastDirection: r.last_dir ?? null,
  }));
}

export interface ThreadFile { filename: string; size: number | null; href: string; note?: string | null }
export interface TimelineItem {
  id: string; direction: 'in' | 'out'; at: string; subject: string | null; body: string | null;
  fromName: string | null; fromAddr: string | null; sender: string | null; status: string | null;
  matchMethod: string | null; files: ThreadFile[];
}

/** One conversation, oldest message first. Combines general mail, BOQ sends and client replies. */
export async function timelineForThread(u: SessionUser, threadId: string): Promise<{ thread: ThreadRow; items: TimelineItem[] }> {
  const thread = await getVisibleThread(u, threadId);
  const { rows } = await query(`
    SELECT 'in' AS direction, i.id, i.received_at AS at, i.from_addr, i.from_name, i.subject, i.body_text,
           i.attachments AS files, NULL::text AS status, NULL::text AS sender, i.match_method
    FROM inbound_messages i WHERE i.thread_id = $1
    UNION ALL
    SELECT 'out', m.id, coalesce(m.sent_at, m.queued_at), NULL, NULL, m.subject, m.body_text,
           m.attachments, m.status, us.full_name, NULL
    FROM mail_messages m LEFT JOIN app_users us ON us.id = m.sent_by WHERE m.thread_id = $1
    UNION ALL
    SELECT 'out', b.id, coalesce(b.sent_at, b.queued_at), NULL, NULL, b.subject, b.body_text,
           (SELECT coalesce(jsonb_agg(jsonb_build_object('filename', x.file_name, 'href', '/api/exports/' || x.id)), '[]'::jsonb)
              FROM boq_exports x WHERE x.id = ANY(b.export_ids)),
           b.status, ub.full_name, NULL
    FROM boq_emails b LEFT JOIN app_users ub ON ub.id = b.sent_by WHERE b.thread_id = $1
    ORDER BY 3 ASC`, [threadId]);

  return {
    thread,
    items: rows.map((r) => ({
      id: r.id, direction: r.direction, at: (r.at as Date).toISOString(), subject: r.subject, body: r.body_text,
      fromName: r.from_name, fromAddr: r.from_addr, sender: r.sender, status: r.status,
      matchMethod: r.match_method,
      files: ((r.files ?? []) as any[]).map((f, i) => ({
        filename: f.filename ?? 'file',
        size: typeof f.size === 'number' ? f.size : null,
        note: f.skipped ?? null,
        href: f.href ?? (r.direction === 'in' ? `/api/replies/${r.id}/files/${i + 1}` : `/api/mail/attachments/${r.id}/${i + 1}`),
      })),
    })),
  };
}

/** Opening a conversation clears its reply notifications for this user. */
export async function markThreadRead(u: SessionUser, threadId: string): Promise<void> {
  await getVisibleThread(u, threadId);
  await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND thread_id = $2 AND read_at IS NULL`, [u.id, threadId]);
}

export async function attachmentFor(u: SessionUser, messageId: string, n: number): Promise<{ buf: Buffer; filename: string; mimeType: string }> {
  const { rows } = await query(`SELECT thread_id, attachments FROM mail_messages WHERE id = $1`, [messageId]);
  if (!rows[0]) throw new ApiError(404, 'File not found.');
  await getVisibleThread(u, rows[0].thread_id);

  let list: StoredAttachment[] = [];
  try { list = validateStored(rows[0].attachments); } catch { throw new ApiError(404, 'File not found.'); }
  const a = list[n - 1];
  if (!a) throw new ApiError(404, 'File not found.');
  const buf = await readStoredAttachment(a.path).catch(() => { throw new ApiError(410, 'The file is no longer stored.'); });
  return { buf, filename: a.filename, mimeType: a.mimeType };
}

export interface ClientOption { id: string; name: string; email: string | null }

/**
 * Clients for a pick-list, searched as the user types (name, e-mail or contact). Capped, so a company with
 * thousands of clients never ships them all to the browser. Names starting with the term come first.
 */
export async function searchClients(q: string, limit = 20): Promise<ClientOption[]> {
  const term = q.trim().slice(0, 100);
  const take = Math.min(Math.max(limit, 1), 50);
  if (!term) {
    const { rows } = await query(`SELECT id, name, email FROM clients WHERE deleted_at IS NULL ORDER BY lower(name), id LIMIT $1`, [take]);
    return rows;
  }
  const { rows } = await query(
    `SELECT id, name, email FROM clients
     WHERE deleted_at IS NULL AND (name ILIKE $1 OR email ILIKE $1 OR contact_person ILIKE $1)
     ORDER BY (lower(name) LIKE lower($2) || '%') DESC, lower(name), id LIMIT $3`,
    [likePattern(term), term.replace(/[%_\\]/g, '\\$&'), take]);
  return rows;
}

/** One client for a pre-filled picker (e.g. "New message" from a client page). Null if removed. */
export async function clientOption(id: string): Promise<ClientOption | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const { rows } = await query(`SELECT id, name, email FROM clients WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] ?? null;
}
