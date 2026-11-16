/**
 * General client mail (npm run test:db): queueing, the worker (fake Gmail), reply threading, conversation privacy
 * and the Unmatched queue. Uses the real database; cleans up after itself.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission, SessionUser } from '@/lib/auth/session';
import { pool } from '@/lib/db';
import { encryptSecret } from '@/lib/mail/crypto';
import type { GmailClient } from '@/lib/mail/gmail';
import { queueMessage, timelineForThread } from '@/lib/mail/messages';
import { unmatchedReplies } from '@/lib/replies';
import { processOne, resetClientCache, type WorkerDeps } from '@/worker/process';

process.env.GOOGLE_CLIENT_ID ||= 'test-client';
process.env.GOOGLE_CLIENT_SECRET ||= 'test-secret';
process.env.GOOGLE_REDIRECT_URI ||= 'http://localhost:3000/api/integrations/gmail/callback';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const tag = `mail-${randomUUID().slice(0, 8)}`;
const MAILBOX = 'testcompany@gmail.com';

let A: SessionUser, B: SessionUser, admin: SessionUser;
let clientId = '';
let backup: Record<string, unknown> | null = null;

async function makeUser(name: string, role: string): Promise<SessionUser> {
  const email = `${tag}-${name}@example.com`;
  const { rows } = await db.query(`INSERT INTO app_users (email, full_name) VALUES ($1, $2) RETURNING id`, [email, name]);
  await db.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`, [rows[0].id, role]);
  const perms = await db.query(`SELECT permission_code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = $1`, [role]);
  return {
    id: rows[0].id, email, fullName: name, designation: null, roles: [role], sessionId: randomUUID(),
    permissions: new Set(perms.rows.map((r) => r.permission_code as Permission)),
  };
}

function fakeGmail() {
  const sent: string[] = [];
  const threaded: (string | null)[] = [];
  const client = {
    async send(raw: Buffer) {
      sent.push(raw.toString());
      threaded.push(null);
      return { id: `gm-${sent.length}`, threadId: 'th-1' };
    },
    async sendInThread(raw: Buffer, threadId: string) {
      sent.push(raw.toString());
      threaded.push(threadId);
      return { id: `gm-${sent.length}`, threadId };
    },
    async headers() { return { 'message-id': `<real-${sent.length}-${tag}@mail.gmail.com>` }; },
  };
  return { client: client as unknown as GmailClient, sent, threaded };
}

const deps = (client: GmailClient): WorkerDeps =>
  (resetClientCache(), { pool, makeClient: () => client, storageDir: path.resolve(process.env.STORAGE_DIR || './storage') });

async function connect() {
  await db.query(`INSERT INTO mail_accounts (id, email, refresh_token_enc, scopes, status) VALUES (1, $1, $2, '{}', 'connected')
                  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, refresh_token_enc = EXCLUDED.refresh_token_enc, status = 'connected', status_detail = NULL`,
    [MAILBOX, encryptSecret('fake-refresh-token')]);
  resetClientCache();
}

beforeAll(async () => {
  await db.connect();
  const existing = await db.query('SELECT * FROM mail_accounts WHERE id = 1');
  backup = existing.rows[0] ?? null;

  A = await makeUser('alice', 'estimator');
  B = await makeUser('bob', 'estimator');
  admin = await makeUser('admin', 'admin');

  const c = await db.query(`INSERT INTO clients (name, email) VALUES ($1, 'client@example.com') RETURNING id`, [`${tag} client`]);
  clientId = c.rows[0].id;
});

afterAll(async () => {
  await db.query(`DELETE FROM mail_threads WHERE owner_user_id = ANY($1::uuid[])`, [[A.id, B.id, admin.id]]);
  await db.query(`DELETE FROM inbound_messages WHERE gmail_message_id LIKE $1`, [`%${tag}%`]);
  await db.query(`DELETE FROM notifications WHERE user_id = ANY($1::uuid[])`, [[A.id, B.id, admin.id]]);
  await db.query(`DELETE FROM app_users WHERE id = ANY($1::uuid[])`, [[A.id, B.id, admin.id]]);
  await db.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await db.query('DELETE FROM mail_accounts WHERE id = 1');
  if (backup) {
    const cols = Object.keys(backup);
    await db.query(`INSERT INTO mail_accounts (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(backup));
  }
  await db.end();
  await pool.end();
});

describe('general client mail', () => {
  it('queues a message, sends it and links the conversation', async () => {
    await connect();
    const q = await queueMessage(A, { clientId, to: 'client@example.com', cc: '', subject: `Site visit ${tag}`, body: 'Hello there.' });

    const th = (await db.query('SELECT owner_user_id, tag, kind, gmail_thread_id FROM mail_threads WHERE id = $1', [q.threadId])).rows[0];
    expect(th).toMatchObject({ owner_user_id: A.id, kind: 'general', gmail_thread_id: null });
    expect(th.tag).toMatch(/^c-[0-9a-f]{8}$/);

    const g = fakeGmail();
    expect(await processOne(deps(g.client))).toBe('sent');

    const m = (await db.query('SELECT status, gmail_message_id, gmail_thread_id, sent_at, reply_to FROM mail_messages WHERE id = $1', [q.messageId])).rows[0];
    expect(m).toMatchObject({ status: 'sent', gmail_message_id: 'gm-1', gmail_thread_id: 'th-1' });
    expect(m.sent_at).not.toBeNull();
    expect(m.reply_to).toBe(`testcompany+${th.tag}@gmail.com`);
    expect((await db.query('SELECT gmail_thread_id FROM mail_threads WHERE id = $1', [q.threadId])).rows[0].gmail_thread_id).toBe('th-1');
    expect((await db.query(`SELECT type FROM notifications WHERE user_id = $1 AND thread_id = $2`, [A.id, q.threadId])).rows.map((r) => r.type))
      .toContain('message_sent');
  });

  it('replies inside the same Gmail thread with proper headers', async () => {
    const th = (await db.query(`SELECT id FROM mail_threads WHERE owner_user_id = $1 ORDER BY last_message_at DESC LIMIT 1`, [A.id])).rows[0];
    const inb = await db.query(
      `INSERT INTO inbound_messages (gmail_message_id, gmail_thread_id, rfc_message_id, from_addr, to_addrs, subject, body_text, received_at, thread_id, match_method)
       VALUES ($1, 'th-1', '<client-1@x>', 'client@example.com', '{testcompany@gmail.com}', 'Re: Site visit', 'Hi', now(), $2, 'thread_tag') RETURNING id`,
      [`in-${tag}-1`, th.id]);

    const q = await queueMessage(A, {
      clientId, to: 'client@example.com', cc: '', subject: 'Site visit', body: 'Thanks for the note.',
      threadId: th.id, replyToInboundId: inb.rows[0].id,
    });
    const m = (await db.query('SELECT in_reply_to, references_hdr, subject, gmail_thread_id FROM mail_messages WHERE id = $1', [q.messageId])).rows[0];
    expect(m.in_reply_to).toBe('<client-1@x>');
    expect(m.subject).toMatch(/^Re: /);
    expect(m.gmail_thread_id).toBe('th-1');

    const g = fakeGmail();
    expect(await processOne(deps(g.client))).toBe('sent');
    expect(g.threaded).toContain('th-1');
    expect(g.sent[0]).toContain('In-Reply-To: <client-1@x>');
    expect(g.sent[0]).toContain('References: <client-1@x>');
  });

  it('keeps a conversation private to its owner (admin/manager only override)', async () => {
    const th = (await db.query(`SELECT id FROM mail_threads WHERE owner_user_id = $1 LIMIT 1`, [A.id])).rows[0];
    await expect(timelineForThread(B, th.id)).rejects.toMatchObject({ status: 404 });
    await expect(timelineForThread(A, th.id)).resolves.toMatchObject({ thread: { id: th.id } });
  });

  it('keeps conversation replies out of the Unmatched queue', async () => {
    const th = (await db.query(`SELECT id FROM mail_threads WHERE owner_user_id = $1 LIMIT 1`, [A.id])).rows[0];
    const conv = await db.query(
      `INSERT INTO inbound_messages (gmail_message_id, gmail_thread_id, from_addr, to_addrs, received_at, thread_id, match_method)
       VALUES ($1, 'th-1', 'client@example.com', '{testcompany@gmail.com}', now(), $2, 'thread_tag') RETURNING id`,
      [`conv-${tag}`, th.id]);
    const loose = await db.query(
      `INSERT INTO inbound_messages (gmail_message_id, gmail_thread_id, from_addr, to_addrs, received_at)
       VALUES ($1, 'zzz', 'stranger@example.com', '{testcompany@gmail.com}', now()) RETURNING id`,
      [`loose-${tag}`]);

    const list = await unmatchedReplies(admin);
    const ids = list.map((r) => r.id);
    expect(ids).toContain(loose.rows[0].id);
    expect(ids).not.toContain(conv.rows[0].id);
  });

  it('refuses a workbook that contains the internal costing sheet', async () => {
    await connect();
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Offer Summary').addRow(['Offer']);
    wb.addWorksheet('Costing (internal)').addRow(['cost', 100]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const before = (await db.query('SELECT count(*)::int AS n FROM mail_messages')).rows[0].n;
    await expect(queueMessage(A, { clientId, to: 'client@example.com', cc: '', subject: `Costing leak ${tag}`, body: 'x' }, [{ buf, fileName: 'costing.xlsx' }]))
      .rejects.toMatchObject({ status: 400 });
    expect((await db.query('SELECT count(*)::int AS n FROM mail_messages')).rows[0].n).toBe(before);
    expect((await db.query('SELECT count(*)::int AS n FROM mail_threads WHERE subject = $1', [`Costing leak ${tag}`])).rows[0].n).toBe(0);
  });
});
