/**
 * Phase 5 integration tests (npm run test:db): reply sync with a fake Gmail inbox.
 * Covers each matching rule, the privacy rules (no body fetched for mail we do not keep), the own-BOQ rule on
 * replies and attachments, notifications, Unmatched assign / discard, duplicates and expired history.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission, SessionUser } from '@/lib/auth/session';
import { pool } from '@/lib/db';
import { encryptSecret } from '@/lib/mail/crypto';
import { GmailApiError, type GmailClient, type GmailMessage } from '@/lib/mail/gmail';
import { assignReply, discardReply, readReplyFile, repliesForBoq, unmatchedReplies, unreadCount } from '@/lib/replies';
import { resetClientCache, type WorkerDeps } from '@/worker/process';
import { ingestMessage, syncReplies } from '@/worker/replies';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const tag = `rep-${randomUUID().slice(0, 8)}`;
const MAILBOX = `${tag}-box@gmail.com`;
const LOCAL = `${tag}-box`;
const X = `${tag}-x@client.com`;      // client with one open BOQ
const Y = `${tag}-y@client.com`;      // client with two open BOQs
let A: SessionUser, B: SessionUser, ADMIN: SessionUser, backup: Record<string, unknown> | null = null;
/** Filled by sentBoq() in beforeAll: the three sent BOQs the fake inbox replies to. */
type SentBoq = { id: string; no: string; tag: string; thread: string; msgId: string };
const boq = {} as Record<'x1' | 'y1' | 'y2', SentBoq>;

async function makeUser(name: string, role: string): Promise<SessionUser> {
  const email = `${tag}-${name}@example.com`;
  const { rows } = await db.query(`INSERT INTO app_users (email, full_name) VALUES ($1, $2) RETURNING id`, [email, name]);
  await db.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`, [rows[0].id, role]);
  const perms = await db.query(`SELECT permission_code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = $1`, [role]);
  return { id: rows[0].id, email, fullName: name, designation: null, roles: [role], sessionId: randomUUID(), permissions: new Set(perms.rows.map((r) => r.permission_code as Permission)) };
}

/** A BOQ already sent (status sent + a boq_emails row), owned by A, for the given client e-mail. */
async function sentBoq(key: 'x1' | 'y1' | 'y2', clientEmail: string) {
  const c = await db.query(`INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id`, [`${tag} ${key}`, clientEmail]);
  const p = await db.query(`INSERT INTO projects (name, client_id, owner_user_id) VALUES ($1, $2, $3) RETURNING id`, [`${tag} project`, c.rows[0].id, A.id]);
  const b = await db.query(`INSERT INTO boqs (project_id, selected_brand_id, exchange_rate, imp_profit_pct, loc_profit_pct, ait_pct, vat_pct, owner_user_id, status, sent_at)
                            VALUES ($1, 1, 122, 10, 10, 5, 7.5, $2, 'sent', now()) RETURNING id, boq_no`, [p.rows[0].id, A.id]);
  const t = `${b.rows[0].boq_no}-r0`.toLowerCase();
  const thread = `T-${key}-${tag}`, msgId = `<sent-${key}-${tag}@mail.gmail.com>`;
  await db.query(`INSERT INTO boq_emails (boq_id, boq_no, revision, sent_by, client_id, to_addrs, subject, body_text, currency_choice, tag, reply_to,
                    status, gmail_message_id, gmail_thread_id, rfc_message_id, sent_at)
                  VALUES ($1, $2, 0, $3, $4, ARRAY[$5], $6, 'x', 'BDT', $7, $8, 'sent', $9, $10, $11, now())`,
    [b.rows[0].id, b.rows[0].boq_no, A.id, c.rows[0].id, clientEmail, `Offer [${b.rows[0].boq_no} R0]`, t, `${LOCAL}+${t}@gmail.com`, `G-${key}-${tag}`, thread, msgId]);
  boq[key] = { id: b.rows[0].id, no: b.rows[0].boq_no, tag: t, thread, msgId };
}

// ---------------------------------------------------------------- fake Gmail
interface FakeMsg { id: string; threadId: string; headers: Record<string, string>; text?: string; attachment?: boolean; labels?: string[] }
function fakeGmail(msgs: FakeMsg[], opts: { historyExpired?: boolean } = {}) {
  const fullFetched = new Set<string>();
  const byId = new Map(msgs.map((m) => [m.id, m]));
  const toApi = (m: FakeMsg, full: boolean): GmailMessage => ({
    id: m.id, threadId: m.threadId, labelIds: m.labels ?? ['INBOX'], snippet: (m.text ?? '').slice(0, 50), internalDate: String(Date.now()),
    payload: {
      mimeType: 'multipart/mixed', headers: Object.entries(m.headers).map(([name, value]) => ({ name, value })),
      parts: full ? [
        { mimeType: 'text/plain', body: { data: Buffer.from(m.text ?? '').toString('base64url') } },
        ...(m.attachment ? [{ mimeType: 'application/pdf', filename: 'drawing.pdf', body: { attachmentId: 'att1', size: 11 } }] : []),
      ] : [],
    },
  });
  const client = {
    async history() {
      if (opts.historyExpired) throw new GmailApiError('Gmail error 404: Requested entity was not found.', 404, false);
      return { historyId: '200', history: [{ messagesAdded: msgs.map((m) => ({ message: { id: m.id, threadId: m.threadId } })) }] };
    },
    async listMessages() { return { messages: msgs.map((m) => ({ id: m.id, threadId: m.threadId })) }; },
    async profile() { return { emailAddress: MAILBOX, historyId: '300' }; },
    async getMessage(id: string, format: 'metadata' | 'full') {
      if (format === 'full') fullFetched.add(id);
      return toApi(byId.get(id)!, format === 'full');
    },
    async attachment() { return Buffer.from('PDF-content'); },
  } as unknown as GmailClient;
  return { client, fullFetched };
}
const deps = (client: GmailClient): WorkerDeps => (resetClientCache(), { pool, makeClient: () => client, storageDir: path.resolve(process.env.STORAGE_DIR || './storage') });
const H = (from: string, subject: string, extra: Record<string, string> = {}) => ({ From: from, To: MAILBOX, Subject: subject, 'Message-ID': `<${randomUUID()}@client>`, ...extra });

beforeAll(async () => {
  await db.connect();
  backup = (await db.query('SELECT * FROM mail_accounts WHERE id = 1')).rows[0] ?? null;
  await db.query('DELETE FROM mail_accounts WHERE id = 1');
  await db.query(`INSERT INTO mail_accounts (id, email, refresh_token_enc, status, history_id) VALUES (1, $1, $2, 'connected', 100)`, [MAILBOX, encryptSecret('fake')]);
  A = await makeUser('Alice', 'estimator');
  B = await makeUser('Bob', 'estimator');
  ADMIN = await makeUser('Admin', 'admin');
  await sentBoq('x1', X);
  await sentBoq('y1', Y);
  await sentBoq('y2', Y);
});

afterAll(async () => {
  const boqs = `SELECT b.id FROM boqs b JOIN projects p ON p.id = b.project_id WHERE p.name = '${tag} project'`;
  await db.query(`DELETE FROM notifications WHERE user_id IN (SELECT id FROM app_users WHERE email LIKE $1) OR inbound_message_id IN (SELECT id FROM inbound_messages WHERE from_addr LIKE $2)`, [`${tag}-%`, `%${tag}%`]);
  await db.query(`DELETE FROM inbound_messages WHERE from_addr LIKE $1`, [`%${tag}%`]);
  await db.query(`DELETE FROM boq_emails WHERE boq_id IN (${boqs})`);
  await db.query(`ALTER TABLE boqs DISABLE TRIGGER boqs_lock`);
  await db.query(`UPDATE boqs SET status = 'draft' WHERE id IN (${boqs})`);
  await db.query(`ALTER TABLE boqs ENABLE TRIGGER boqs_lock`);
  await db.query(`DELETE FROM boqs WHERE id IN (${boqs})`);
  await db.query(`DELETE FROM projects WHERE name = $1`, [`${tag} project`]);
  await db.query(`DELETE FROM clients WHERE name LIKE $1`, [`${tag} %`]);
  await db.query(`DELETE FROM app_users WHERE email LIKE $1`, [`${tag}-%`]);
  await db.query('DELETE FROM mail_accounts WHERE id = 1');
  if (backup) {
    const cols = Object.keys(backup);
    await db.query(`INSERT INTO mail_accounts (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(backup));
  }
  await db.end();
  await pool.end();
});

describe('reply sync', () => {
  let fake: ReturnType<typeof fakeGmail>;
  const ids = { thread: '', header: '', tag: '', subject: '', sender: '', newsletter: '', auto: '', unmatched: '', own: '' };

  it('routes each kind of mail by the plan’s rules and stores only what it should', async () => {
    const m = (k: keyof typeof ids, msg: Omit<FakeMsg, 'id'>) => { ids[k] = `${k}-${tag}`; return { id: ids[k], ...msg }; };
    fake = fakeGmail([
      m('thread', { threadId: boq.x1.thread, headers: H(`"Mr. X" <${X}>`, 'Re: Offer'), text: 'Please reduce 5%.\n\nOn Mon wrote:\n> old', attachment: true }),
      m('header', { threadId: 'NEW1', headers: H(X, 'Price question', { 'In-Reply-To': boq.y1.msgId }), text: 'header match' }),
      m('tag', { threadId: 'NEW2', headers: H(X, 'fwd', { To: `${LOCAL}+${boq.y2.tag}@gmail.com` }), text: 'tag match' }),
      m('subject', { threadId: 'NEW3', headers: H(Y, `About ${boq.x1.no} R0 please`), text: 'subject match' }),
      m('sender', { threadId: 'NEW4', headers: H(X, 'Hello again'), text: 'sender match' }),
      m('newsletter', { threadId: 'NEW5', headers: H(`news-${tag}@shop.com`, 'Big sale'), text: 'buy now' }),
      m('auto', { threadId: 'NEW6', headers: H(X, 'Out of office', { 'Auto-Submitted': 'auto-replied' }), text: 'away' }),
      m('unmatched', { threadId: 'NEW7', headers: H(Y, 'Question'), text: 'which offer was cheaper?' }),
      m('own', { threadId: 'NEW8', headers: H(MAILBOX, 'note to self'), text: 'self' }),
    ]);
    const res = await syncReplies(deps(fake.client));
    expect(res).toEqual({ checked: 9, matched: 5, unmatched: 1, ignored: 3 });

    const rows = (await db.query(`SELECT gmail_message_id, boq_id, match_method, assigned_to, attachments FROM inbound_messages WHERE from_addr LIKE $1 OR from_addr = $2 OR from_addr = $3`, [`%${tag}%`, X, Y])).rows;
    const by = Object.fromEntries(rows.map((r) => [r.gmail_message_id, r]));
    expect(by[ids.thread]).toMatchObject({ boq_id: boq.x1.id, match_method: 'thread', assigned_to: A.id });
    expect(by[ids.header]).toMatchObject({ boq_id: boq.y1.id, match_method: 'header' });
    expect(by[ids.tag]).toMatchObject({ boq_id: boq.y2.id, match_method: 'plus_tag' });
    expect(by[ids.subject]).toMatchObject({ boq_id: boq.x1.id, match_method: 'subject_code' });
    expect(by[ids.sender]).toMatchObject({ boq_id: boq.x1.id, match_method: 'sender' });
    expect(by[ids.unmatched]).toMatchObject({ boq_id: null, match_method: null });
    for (const k of ['newsletter', 'auto', 'own'] as const) expect(by[ids[k]]).toBeUndefined();
    // privacy: the body of mail we do not keep is never downloaded
    for (const k of ['newsletter', 'auto', 'own'] as const) expect(fake.fullFetched.has(ids[k])).toBe(false);
    expect(by[ids.thread].attachments[0]).toMatchObject({ filename: 'drawing.pdf', path: expect.stringMatching(/^inbound\//) });
    expect((await db.query(`SELECT history_id::text FROM mail_accounts WHERE id = 1`)).rows[0].history_id).toBe('200');
  });

  it('notifies the owner per matched reply and the admins per unmatched one', async () => {
    expect(await unreadCount(A.id)).toBe(5);
    expect(await unreadCount(B.id)).toBe(0);
    const n = await db.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'reply_unmatched'`, [ADMIN.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('own-BOQ rule: only the owner (and admins) see replies and their files', async () => {
    const replies = await repliesForBoq(A, boq.x1.id);
    expect(replies.map((r) => r.fromAddr).sort()).toEqual([X, X, Y].sort());
    expect(replies.find((r) => r.matchMethod === 'thread')!.bodyText).toContain('Please reduce 5%');
    expect(await unreadCount(A.id)).toBe(2);   // opening the BOQ marked its 3 replies read
    await expect(repliesForBoq(B, boq.x1.id)).rejects.toMatchObject({ status: 404 });
    const withFile = replies.find((r) => r.files.length)!;
    expect((await readReplyFile(A, withFile.id, 1)).buf.toString()).toBe('PDF-content');
    await expect(readReplyFile(B, withFile.id, 1)).rejects.toMatchObject({ status: 404 });
    expect((await repliesForBoq(ADMIN, boq.x1.id)).length).toBe(3);
    await expect(unmatchedReplies(A)).rejects.toMatchObject({ status: 403 });
  });

  it('admin assigns an unmatched reply; the owner is notified', async () => {
    const [u] = await unmatchedReplies(ADMIN);
    if (!u) throw new Error('expected one unmatched reply to assign');
    expect(u.fromAddr).toBe(Y);
    await assignReply(ADMIN, u.id, boq.y2.id);
    expect((await db.query(`SELECT match_method, assigned_by FROM inbound_messages WHERE id = $1`, [u.id])).rows[0]).toMatchObject({ match_method: 'manual', assigned_by: ADMIN.id });
    expect((await repliesForBoq(A, boq.y2.id)).some((r) => r.id === u.id)).toBe(true);
    await expect(assignReply(ADMIN, u.id, boq.y1.id)).rejects.toMatchObject({ status: 409 });
    expect(await unmatchedReplies(ADMIN)).toEqual([]);
  });

  it('skips duplicates, recovers from expired history, and admins can discard', async () => {
    expect(await ingestMessage(deps(fake.client), fake.client, ids.thread, MAILBOX)).toBe('duplicate');
    const late = fakeGmail([{ id: `late-${tag}`, threadId: 'NEW9', headers: H(Y, 'one more'), text: 'hi' }], { historyExpired: true });
    const res = await syncReplies(deps(late.client));
    expect(res).toMatchObject({ checked: 1, unmatched: 1 });
    expect((await db.query(`SELECT history_id::text FROM mail_accounts WHERE id = 1`)).rows[0].history_id).toBe('300');
    const [u] = await unmatchedReplies(ADMIN);
    if (!u) throw new Error('expected one unmatched reply to discard');
    await discardReply(ADMIN, u.id);
    expect(await unmatchedReplies(ADMIN)).toEqual([]);
  });
});
