/**
 * Reply sync (phase 5). Reads new INBOX mail since the last Gmail historyId and routes client replies.
 * Privacy, as in the plan:
 *   - pass 1 reads HEADERS ONLY and decides (6 matching rules, auto-replies ignored, our own mail ignored);
 *   - the body is fetched only for a matched reply, or for mail from a known client / with a BOQ code
 *     (that goes to the admin-only Unmatched list);
 *   - everything else is never stored.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { GmailApiError, GmailAuthError, type GmailClient } from '@/lib/mail/gmail';
import { SecretError } from '@/lib/mail/crypto';
import { addressOf, isAutoReply, matchReply, messageIds, parseSubjectCode, plusTag, type Inbound, type SentEmail } from '@/lib/mail/match';
import { addressList, displayName, headerMap, MATCH_HEADERS, parseBody } from '@/lib/mail/parse';
import { gmailFor, pauseForAuth, usersWith, withUser, type WorkerDeps } from './process';

const MAX_ATTACHMENT = 20 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
const FALLBACK_QUERY = 'in:inbox newer_than:3d';
const failures = new Map<string, number>();   // message id -> failed attempts (poison-message guard)

export type IngestResult = 'matched' | 'unmatched' | 'ignored' | 'duplicate';
export interface SyncResult { checked: number; matched: number; unmatched: number; ignored: number }

const mapSent = (r: Record<string, any>): SentEmail => ({
  id: r.id, boqId: r.boq_id, boqNo: r.boq_no, revision: r.revision, ownerId: r.owner_user_id, tag: r.tag,
  gmailThreadId: r.gmail_thread_id, rfcMessageId: r.rfc_message_id, sentAt: r.sent_at, threadId: r.thread_id,
});
const SENT_COLS = `e.id, e.boq_id, e.boq_no, e.revision, e.tag, e.gmail_thread_id, e.rfc_message_id, e.sent_at, e.thread_id, b.owner_user_id`;

/** Only the sent rows that could match this message (thread, Message-IDs, plus tags, subject code). */
async function candidates(pool: pg.Pool, msg: Inbound, mailboxLocal: string, mailboxDomain: string) {
  const refs = [...messageIds(msg.inReplyTo), ...messageIds(msg.references)];
  const tags = [...msg.to, ...msg.cc].map((a) => plusTag(a, mailboxLocal, mailboxDomain)).filter((t): t is string => !!t).map((t) => t.toLowerCase());
  const code = parseSubjectCode(msg.subject);
  const { rows } = await pool.query(
    `SELECT ${SENT_COLS} FROM boq_emails e JOIN boqs b ON b.id = e.boq_id
     WHERE e.status = 'sent' AND b.deleted_at IS NULL AND (
       e.gmail_thread_id = $1
       OR lower(trim(both '<>' from e.rfc_message_id)) = ANY($2::text[])
       OR lower(e.tag) = ANY($3::text[])
       OR e.boq_no = $4)`,
    [msg.threadId, refs, tags, code?.boqNo ?? null]);
  return rows.map(mapSent);
}

/** Latest send of each OPEN (status sent, not superseded) BOQ for the client with this address. */
async function openBoqsFor(pool: pg.Pool, from: string) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (e.boq_id) ${SENT_COLS}
     FROM boq_emails e JOIN boqs b ON b.id = e.boq_id JOIN projects p ON p.id = b.project_id LEFT JOIN clients c ON c.id = p.client_id
     WHERE e.status = 'sent' AND b.status = 'sent' AND b.deleted_at IS NULL AND (c.email = $1 OR $1 = ANY(e.to_addrs) OR $1 = ANY(e.cc_addrs))
     ORDER BY e.boq_id, e.sent_at DESC`, [from]);
  return rows.map(mapSent);
}

/** Conversations that could own this message: same Gmail thread, same plus tag, or a quoted Message-ID. */
async function threadCandidates(pool: pg.Pool, msg: Inbound, mailboxLocal: string, mailboxDomain: string) {
  const refs = [...messageIds(msg.inReplyTo), ...messageIds(msg.references)];
  const tags = [...msg.to, ...msg.cc].map((a) => plusTag(a, mailboxLocal, mailboxDomain)).filter((t): t is string => !!t).map((t) => t.toLowerCase());
  const threads = (await pool.query(
    `SELECT t.id, t.owner_user_id AS owner_id, t.tag, t.gmail_thread_id, t.boq_no, t.subject
     FROM mail_threads t
     WHERE t.gmail_thread_id = $1 OR lower(t.tag) = ANY($2::text[])
     ORDER BY t.last_message_at DESC LIMIT 50`, [msg.threadId, tags])).rows
    .map((r) => ({ id: r.id as string, ownerId: r.owner_id as string | null, tag: r.tag as string, gmailThreadId: r.gmail_thread_id as string | null, boqNo: r.boq_no as string | null, subject: r.subject as string }));
  const threadMessages = (await pool.query(
    `SELECT id, thread_id, rfc_message_id FROM mail_messages
     WHERE rfc_message_id IS NOT NULL AND lower(trim(both '<>' from rfc_message_id)) = ANY($1::text[])
     LIMIT 50`, [refs])).rows
    .map((r) => ({ id: r.id as string, threadId: r.thread_id as string, rfcMessageId: r.rfc_message_id as string | null }));
  return { threads, threadMessages };
}

async function isKnownSender(pool: pg.Pool, from: string) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM clients WHERE email = $1 AND deleted_at IS NULL
     UNION ALL SELECT 1 FROM boq_emails WHERE status = 'sent' AND ($1 = ANY(to_addrs) OR $1 = ANY(cc_addrs)) LIMIT 1`, [from]);
  return !!rowCount;
}

/** Route one Gmail message. Exported for tests. */
export async function ingestMessage(deps: WorkerDeps, gmail: GmailClient, messageId: string, mailbox: string): Promise<IngestResult> {
  const { pool } = deps;
  const exists = await pool.query(`SELECT 1 FROM inbound_messages WHERE gmail_message_id = $1 UNION ALL SELECT 1 FROM boq_emails WHERE gmail_message_id = $1`, [messageId]);
  if (exists.rowCount) return 'duplicate';

  // Pass 1: headers only.
  const meta = await gmail.getMessage(messageId, 'metadata', MATCH_HEADERS);
  const h = headerMap(meta);
  const from = addressOf(h.from ?? '');
  const labels = meta.labelIds ?? [];
  if (!from || from === mailbox.toLowerCase() || labels.includes('SENT') || labels.includes('SPAM') || labels.includes('DRAFT')) return 'ignored';
  if (isAutoReply(h)) return 'ignored';

  const msg: Inbound = {
    threadId: meta.threadId, inReplyTo: h['in-reply-to'] ?? null, references: h.references ?? null,
    to: [...addressList(h.to), ...addressList(h['delivered-to'])], cc: addressList(h.cc), subject: h.subject ?? null, from,
  };
  const [mailboxLocal = '', mailboxDomain = ''] = mailbox.split('@');
  const [cands, open, conv] = await Promise.all([
    candidates(pool, msg, mailboxLocal, mailboxDomain),
    openBoqsFor(pool, from),
    threadCandidates(pool, msg, mailboxLocal, mailboxDomain),
  ]);
  // Weak rules (plus tag, subject code, bare From) only count for a known client whose SPF/DKIM passed.
  const known = await isKnownSender(pool, from);
  const auth = (h['authentication-results'] ?? '').toLowerCase();
  const authFailed = /(?:spf|dkim|dmarc)\s*=\s*(?:fail|softfail|permerror)/.test(auth);
  const trusted = known && !authFailed;
  const match = matchReply(msg, {
    sent: cands, openBoqsBySender: () => open, mailboxLocalPart: mailboxLocal, mailboxDomain,
    threads: conv.threads, threadMessages: conv.threadMessages, isKnownSender: trusted,
  });
  if (!match && !known && !parseSubjectCode(msg.subject)) return 'ignored';   // not a client: never stored

  // Pass 2: the body, only for mail we keep.
  const full = await gmail.getMessage(messageId, 'full');
  const body = parseBody(full);
  const id = randomUUID();
  const dir = path.join(deps.storageDir, 'inbound', id);
  const files: { filename: string; mimeType: string; size: number; path?: string; skipped?: string }[] = [];
  let total = 0;
  for (const [i, a] of body.attachments.entries()) {
    if (a.size > MAX_ATTACHMENT || total + a.size > MAX_TOTAL) { files.push({ filename: a.filename, mimeType: a.mimeType, size: a.size, skipped: 'too large; open it in Gmail' }); continue; }
    const buf = await gmail.attachment(messageId, a.attachmentId);
    total += buf.length;
    await mkdir(dir, { recursive: true });
    const rel = path.posix.join('inbound', id, `${i + 1}`);
    await writeFile(path.join(deps.storageDir, rel), buf);
    files.push({ filename: a.filename, mimeType: a.mimeType, size: buf.length, path: rel });
  }

  const receivedAt = full.internalDate ? new Date(Number(full.internalDate)) : new Date();
  const name = displayName(h.from) ?? from;
  const threadId = match?.thread?.id ?? match?.email?.threadId ?? null;
  const conversationOwner = match?.thread?.ownerId ?? match?.email?.ownerId ?? null;
  try {
    const inserted = await withUser(pool, null, async (c) => {
      const r = await c.query(
        `INSERT INTO inbound_messages (id, gmail_message_id, gmail_thread_id, rfc_message_id, in_reply_to, references_hdr, from_addr, from_name,
           to_addrs, cc_addrs, subject, snippet, body_text, body_html, attachments, received_at, boq_id, boq_email_id, match_method, assigned_to, assigned_at,
           thread_id, thread_message_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                 CASE WHEN $20::uuid IS NULL THEN NULL ELSE now() END, $21, $22)
         ON CONFLICT (gmail_message_id) DO NOTHING RETURNING id`,
        [id, messageId, meta.threadId, h['message-id'] ?? null, msg.inReplyTo, msg.references, from, displayName(h.from), msg.to, msg.cc,
          msg.subject?.slice(0, 500) ?? null, (full.snippet ?? '').slice(0, 300), body.text, body.html, JSON.stringify(files), receivedAt,
          match?.email?.boqId ?? null, match?.email?.id ?? null, match?.method ?? null, conversationOwner,
          threadId, match?.threadMessageId ?? null]);
      if (!r.rowCount) return false;
      if (match?.email) {
        if (match.email.ownerId) {
          await c.query(`INSERT INTO notifications (user_id, type, boq_id, thread_id, inbound_message_id, title, body) VALUES ($1, 'reply_received', $2, $3, $4, $5, $6)`,
            [match.email.ownerId, match.email.boqId, threadId, id, `Reply from ${name} on ${match.email.boqNo} R${match.email.revision}`, (full.snippet ?? '').slice(0, 200)]);
        }
      } else if (match?.thread) {
        if (match.thread.ownerId) {
          await c.query(`INSERT INTO notifications (user_id, type, thread_id, inbound_message_id, title, body) VALUES ($1, 'message_received', $2, $3, $4, $5)`,
            [match.thread.ownerId, match.thread.id, id, `New message from ${name}`, (msg.subject ?? '').slice(0, 200)]);
        }
      } else {
        for (const admin of await usersWith(c, 'mail.unmatched.manage')) {
          await c.query(`INSERT INTO notifications (user_id, type, inbound_message_id, title, body) VALUES ($1, 'reply_unmatched', $2, $3, $4)`,
            [admin, id, `Unmatched mail from ${name}`, (msg.subject ?? '').slice(0, 200)]);
        }
      }
      return true;
    });
    if (!inserted) { await rm(dir, { recursive: true, force: true }); return 'duplicate'; }
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
  deps.log?.(match?.email
    ? `reply ${messageId} -> ${match.email.boqNo} R${match.email.revision} (${match.method})`
    : match?.thread
      ? `reply ${messageId} -> conversation ${match.thread.id} (${match.method})`
      : `reply ${messageId} unmatched`);
  return match ? 'matched' : 'unmatched';
}

/** One sync pass. Returns null when Gmail is not connected. */
export async function syncReplies(deps: WorkerDeps): Promise<SyncResult | null> {
  const { pool } = deps;
  const acc = (await pool.query(`SELECT email, refresh_token_enc, status, history_id::text AS history_id FROM mail_accounts WHERE id = 1`)).rows[0];
  if (!acc || acc.status !== 'connected') return null;
  let gmail: GmailClient;
  try {
    gmail = gmailFor(deps, acc.refresh_token_enc);
  } catch (e) {
    // A key change (or a restored dump) makes the stored token unreadable: pause instead of retrying forever.
    if (e instanceof SecretError) { await pauseForAuth(deps, (e as Error).message); return null; }
    throw e;
  }
  const out: SyncResult = { checked: 0, matched: 0, unmatched: 0, ignored: 0 };

  try {
    if (!acc.history_id) {
      const p = await gmail.profile();
      await pool.query(`UPDATE mail_accounts SET history_id = $1, last_sync_at = now() WHERE id = 1`, [p.historyId]);
      return out;   // start from now; earlier mail is not imported
    }

    let ids: string[] = [];
    let newHistory: string;
    try {
      let page: string | undefined;
      newHistory = acc.history_id;
      do {
        const r = await gmail.history(acc.history_id, page);
        for (const hst of r.history ?? []) for (const a of hst.messagesAdded ?? []) ids.push(a.message.id);
        newHistory = r.historyId ?? newHistory;
        page = r.nextPageToken;
      } while (page);
    } catch (e) {
      if (!(e instanceof GmailApiError && e.status === 404)) throw e;
      // History expired (worker was off for a long time): look at recent inbox mail instead. Duplicates are skipped.
      deps.log?.('history too old, resyncing recent inbox');
      ids = [];
      let page: string | undefined;
      do { const r = await gmail.listMessages(FALLBACK_QUERY, page); ids.push(...(r.messages ?? []).map((m) => m.id)); page = r.nextPageToken; } while (page && ids.length < 2000);
      newHistory = (await gmail.profile()).historyId;
    }

    let blocked = false;
    for (const id of [...new Set(ids)]) {
      out.checked++;
      try {
        const r = await ingestMessage(deps, gmail, id, acc.email);
        if (r === 'matched') out.matched++; else if (r === 'unmatched') out.unmatched++; else out.ignored++;
        failures.delete(id);
      } catch (e) {
        if (e instanceof GmailAuthError) throw e;
        const n = (failures.get(id) ?? 0) + 1;
        failures.set(id, n);
        deps.log?.(`reply ${id} failed (${n}): ${(e as Error).message}`);
        if (n < 3) blocked = true;   // keep the history id so it is tried again; after 3 tries it is skipped
      }
    }
    if (!blocked) await pool.query(`UPDATE mail_accounts SET history_id = $1, last_sync_at = now() WHERE id = 1 AND status = 'connected'`, [newHistory]);
    else await pool.query(`UPDATE mail_accounts SET last_sync_at = now() WHERE id = 1`);
    return out;
  } catch (e) {
    if (e instanceof GmailAuthError) { await pauseForAuth(deps, e.message); return null; }
    throw e;
  }
}

/** Optional Pub/Sub push (GMAIL_PUBSUB_TOPIC). Renewed a day before Google lets it lapse. */
export async function renewWatch(deps: WorkerDeps, topic: string | undefined) {
  if (!topic) return;
  const acc = (await deps.pool.query(`SELECT refresh_token_enc, status, watch_expires_at FROM mail_accounts WHERE id = 1`)).rows[0];
  if (!acc || acc.status !== 'connected') return;
  if (acc.watch_expires_at && new Date(acc.watch_expires_at).getTime() > Date.now() + 24 * 3600_000) return;
  try {
    const w = await gmailFor(deps, acc.refresh_token_enc).watch(topic);
    await deps.pool.query(`UPDATE mail_accounts SET watch_expires_at = to_timestamp($1::bigint / 1000.0) WHERE id = 1`, [w.expiration]);
    deps.log?.(`gmail push watch renewed until ${new Date(Number(w.expiration)).toISOString()}`);
  } catch (e) {
    if (e instanceof GmailAuthError) await pauseForAuth(deps, e.message);
    else deps.log?.(`watch renewal failed (polling still works): ${(e as Error).message}`);
  }
}
