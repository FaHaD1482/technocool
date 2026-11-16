/**
 * Phase 4 integration tests (npm run test:db): Send pre-checks, queueing, and the worker with a fake Gmail.
 * Any real Gmail connection in mail_accounts is backed up and restored.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import ExcelJS from 'exceljs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Permission, SessionUser } from '@/lib/auth/session';
import { calculate } from '@/lib/calc';
import { loadEditorData, saveBoq } from '@/lib/boq/repo';
import { mergeWithCatalog, shouldPersist, toCalcRow, toCalcSettings } from '@/lib/boq/rows';
import { pool } from '@/lib/db';
import { encryptSecret } from '@/lib/mail/crypto';
import { GmailApiError, GmailAuthError, type GmailClient } from '@/lib/mail/gmail';
import { queueSend, sendPreflight, emailsForBoq } from '@/lib/mail/send';
import { processOne, recoverStuck, resetClientCache, type WorkerDeps } from '@/worker/process';

process.env.GOOGLE_CLIENT_ID ||= 'test-client';
process.env.GOOGLE_CLIENT_SECRET ||= 'test-secret';
process.env.GOOGLE_REDIRECT_URI ||= 'http://localhost:3000/api/integrations/gmail/callback';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const tag = `send-${randomUUID().slice(0, 8)}`;
const MAILBOX = 'testcompany@gmail.com';
let A: SessionUser, B: SessionUser, clientId: string, backup: Record<string, unknown> | null = null;
/** Created so the "Gmail disconnected" alert has a recipient (it goes to holders of `integrations.gmail.manage`). */
let _admin: SessionUser;
const startedAt = new Date();

async function makeUser(name: string, role: string): Promise<SessionUser> {
  const email = `${tag}-${name}@example.com`;
  const { rows } = await db.query(`INSERT INTO app_users (email, full_name, designation) VALUES ($1, $2, 'Sales Engineer') RETURNING id`, [email, name]);
  await db.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2`, [rows[0].id, role]);
  const perms = await db.query(`SELECT permission_code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = $1`, [role]);
  return { id: rows[0].id, email, fullName: name, designation: null, roles: [role], sessionId: randomUUID(), permissions: new Set(perms.rows.map((r) => r.permission_code as Permission)) };
}

/** A BOQ owned by u with priced LG lines (and optionally an unpriced DB-brand line selected). */
async function makeBoq(u: SessionUser, opts: { unpriced?: boolean } = {}) {
  const p = await db.query(`INSERT INTO projects (name, client_id, owner_user_id, created_by) VALUES ($1, $2, $3, $3) RETURNING id`, [`${tag} project`, clientId, u.id]);
  const brand = opts.unpriced ? 'DB' : 'LG';
  const b = await db.query(
    `INSERT INTO boqs (project_id, selected_brand_id, exchange_rate, imp_profit_pct, loc_profit_pct, ait_pct, vat_pct, owner_user_id, created_by)
     VALUES ($1, (SELECT id FROM brands WHERE code = $3), 122, 10, 10, 5, 7.5, $2, $2) RETURNING id`, [p.rows[0].id, u.id, brand]);
  const id = b.rows[0].id as string;
  const data = await loadEditorData(u, id);
  const rows = mergeWithCatalog(data.rows, data.catalog);
  let n = 0;
  for (const r of rows) if (r.line === 'A' && r.brandId === data.settings.selectedBrandId && n < 2) { r.qty = '2'; n++; }
  const calc = calculate(rows.map(toCalcRow), toCalcSettings(data.settings));
  await saveBoq(u, id, { version: data.header.version, settings: data.settings, rows: rows.filter((r) => shouldPersist(r, calc.items.get(r.key)!.qty)) });
  return id;
}

function fakeGmail(behaviour: 'ok' | 'fail' | 'retry' | 'auth') {
  const sent: string[] = [];
  const client = {
    async send(raw: Buffer) {
      if (behaviour === 'fail') throw new GmailApiError('Gmail error 400: Invalid To header', 400, false);
      if (behaviour === 'retry') throw new GmailApiError('Gmail error 503: backend error', 503, true);
      if (behaviour === 'auth') throw new GmailAuthError('Gmail access was revoked or expired (invalid_grant).');
      sent.push(raw.toString());
      return { id: `gm-${sent.length}`, threadId: `th-${sent.length}` };
    },
    async headers() { return { 'message-id': `<CAreal-${sent.length}-${tag}@mail.gmail.com>` }; },
  } as unknown as GmailClient;
  return { client, sent };
}

const deps = (client: GmailClient): WorkerDeps => (resetClientCache(), { pool, makeClient: () => client, storageDir: path.resolve(process.env.STORAGE_DIR || './storage'), log: (m) => { if (process.env.DEBUG_WORKER) console.log(m); } });
const input = (currency: 'BDT' | 'USD' | 'BOTH' = 'BOTH') => ({ to: 'Client@Example.com', cc: '', subject: 'Price offer', body: 'Dear Sir,\nPlease find attached.', currency, attachment: 'generated' as const });

/** A workbook like the one an estimator saves in Excel. */
async function xlsx(sheets: string[]) {
  const wb = new ExcelJS.Workbook();
  for (const name of sheets) wb.addWorksheet(name).addRow(['Offer']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function connect() {
  await db.query(`INSERT INTO mail_accounts (id, email, refresh_token_enc, scopes, status) VALUES (1, $1, $2, '{}', 'connected')
                  ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, refresh_token_enc = EXCLUDED.refresh_token_enc, status = 'connected', status_detail = NULL`,
    [MAILBOX, encryptSecret('fake-refresh-token')]);
  resetClientCache();
}

beforeAll(async () => {
  await db.connect();
  backup = (await db.query('SELECT * FROM mail_accounts WHERE id = 1')).rows[0] ?? null;
  await db.query('DELETE FROM mail_accounts WHERE id = 1');
  A = await makeUser('Alice', 'estimator');
  B = await makeUser('Bob', 'estimator');
  _admin = await makeUser('Admin', 'admin');       // holds integrations.gmail.manage: the disconnect alert goes here
  clientId = (await db.query(`INSERT INTO clients (name, contact_person, email) VALUES ($1, 'Mr. Rahman', 'client@example.com') RETURNING id`, [`${tag} client`])).rows[0].id;
});

afterAll(async () => {
  const boqs = `SELECT b.id FROM boqs b JOIN projects p ON p.id = b.project_id WHERE p.name = '${tag} project'`;
  await db.query(`DELETE FROM notifications WHERE boq_id IN (${boqs}) OR (type = 'gmail_disconnected' AND created_at >= $1)`, [startedAt]);
  await db.query(`DELETE FROM boq_emails WHERE boq_id IN (${boqs})`);
  await db.query(`ALTER TABLE boqs DISABLE TRIGGER boqs_lock`);
  await db.query(`UPDATE boqs SET status = 'draft' WHERE id IN (${boqs})`);
  await db.query(`ALTER TABLE boqs ENABLE TRIGGER boqs_lock`);
  await db.query(`DELETE FROM boq_exports WHERE boq_id IN (${boqs})`);
  await db.query(`DELETE FROM mail_threads WHERE boq_no IN (SELECT boq_no FROM boqs WHERE id IN (${boqs}))`);
  await db.query(`DELETE FROM boqs WHERE id IN (${boqs})`);
  await db.query(`DELETE FROM projects WHERE name = $1`, [`${tag} project`]);
  await db.query(`DELETE FROM clients WHERE id = $1`, [clientId]);
  await db.query(`DELETE FROM app_users WHERE email LIKE $1`, [`${tag}-%`]);
  await db.query('DELETE FROM mail_accounts WHERE id = 1');
  if (backup) {
    const cols = Object.keys(backup);
    await db.query(`INSERT INTO mail_accounts (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(backup));
  }
  await db.end();
  await pool.end();
});

describe('Send pre-checks', () => {
  it('blocks while Gmail is not connected', async () => {
    const id = await makeBoq(A);
    const pre = await sendPreflight(A, id);
    expect(pre.blockers.join(' ')).toMatch(/not connected/);
    await expect(queueSend(A, id, input())).rejects.toMatchObject({ status: 409 });
  });

  it('fills the template, keeps the code in the subject, and blocks 0 rates', async () => {
    await connect();
    const id = await makeBoq(A);
    const pre = await sendPreflight(A, id);
    expect(pre.blockers).toEqual([]);
    expect(pre.subject).toMatch(/\[BOQ-\d{4}-\d{4} R0\]$/);
    expect(pre.body).toContain('Dear Mr. Rahman');
    expect(pre.replyTo).toMatch(/^testcompany\+b-[0-9a-f]{10}@gmail\.com$/);
    const zero = await makeBoq(A, { unpriced: true });   // DB brand: no prices in the price list
    expect((await sendPreflight(A, zero)).blockers.join(' ')).toMatch(/rate of 0/);
    await expect(queueSend(A, zero, input())).rejects.toMatchObject({ status: 409 });
  });

  it('only the owner can send', async () => {
    const id = await makeBoq(A);
    await expect(queueSend(B, id, input())).rejects.toMatchObject({ status: 404 });
  });

  it('blocks sending to a client that was removed from the list', async () => {
    await connect();
    const id = await makeBoq(A);
    await db.query(`UPDATE clients SET deleted_at = now() WHERE id = $1`, [clientId]);
    try {
      expect((await sendPreflight(A, id)).blockers.join(' ')).toMatch(/removed from the client list/);
      await expect(queueSend(A, id, input())).rejects.toMatchObject({ status: 409 });
      expect((await db.query('SELECT status FROM boqs WHERE id = $1', [id])).rows[0].status).toBe('draft');
    } finally {
      await db.query(`UPDATE clients SET deleted_at = NULL WHERE id = $1`, [clientId]);
    }
  });
});

describe('queue + worker', () => {
  it('queues, locks the BOQ, refuses a second send, and the worker sends it', async () => {
    await connect();
    const id = await makeBoq(A);
    const q = await queueSend(A, id, input('BOTH'));
    expect(q.files).toHaveLength(2);
    expect((await db.query('SELECT status FROM boqs WHERE id = $1', [id])).rows[0].status).toBe('sent');
    await expect(queueSend(A, id, input())).rejects.toMatchObject({ status: 409 });

    const g = fakeGmail('ok');
    expect(await processOne(deps(g.client))).toBe('sent');
    const e = (await db.query('SELECT * FROM boq_emails WHERE id = $1', [q.emailId])).rows[0];
    expect(e).toMatchObject({ status: 'sent', gmail_message_id: 'gm-1', gmail_thread_id: 'th-1', rfc_message_id: `<CAreal-1-${tag}@mail.gmail.com>`, attempts: 1 });
    expect(e.to_addrs).toEqual(['client@example.com']);
    const raw = g.sent[0] ?? '';
    expect(raw).toContain(`Reply-To: ${e.reply_to}`);
    expect(raw).toContain(e.subject);
    expect((raw.match(/Content-Disposition: attachment/g) ?? []).length).toBe(2);
    expect(raw).not.toMatch(/costing/i);
    const b = (await db.query('SELECT status, sent_at FROM boqs WHERE id = $1', [id])).rows[0];
    expect(b.status).toBe('sent');
    expect(b.sent_at).not.toBeNull();
    const n = await db.query(`SELECT type FROM notifications WHERE user_id = $1 AND boq_id = $2`, [A.id, id]);
    expect(n.rows.map((r) => r.type)).toEqual(['send_succeeded']);
    expect(await processOne(deps(g.client))).toBe('idle');
  });

  it('a permanent failure unlocks the BOQ and tells the sender', async () => {
    const id = await makeBoq(A);
    const q = await queueSend(A, id, input('BDT'));
    expect(await processOne(deps(fakeGmail('fail').client))).toBe('failed');
    expect((await db.query('SELECT status, last_error FROM boq_emails WHERE id = $1', [q.emailId])).rows[0]).toMatchObject({ status: 'failed', last_error: expect.stringMatching(/Invalid To/) });
    expect((await db.query('SELECT status FROM boqs WHERE id = $1', [id])).rows[0].status).toBe('draft');
    expect((await db.query(`SELECT count(*)::int AS n FROM notifications WHERE boq_id = $1 AND type = 'send_failed'`, [id])).rows[0].n).toBe(1);
  });

  it('a temporary Gmail error is retried later', async () => {
    const id = await makeBoq(A);
    const q = await queueSend(A, id, input('USD'));
    expect(await processOne(deps(fakeGmail('retry').client))).toBe('retry');
    const e = (await db.query(`SELECT status, attempts, not_before > now() AS later FROM boq_emails WHERE id = $1`, [q.emailId])).rows[0];
    expect(e).toMatchObject({ status: 'queued', attempts: 1, later: true });
    expect(await processOne(deps(fakeGmail('ok').client))).toBe('idle');   // not due yet
    await db.query(`UPDATE boq_emails SET not_before = now() WHERE id = $1`, [q.emailId]);
  });

  it('a revoked token pauses sending, keeps the mail queued and alerts the admins', async () => {
    await connect();
    resetClientCache();
    expect(await processOne(deps(fakeGmail('auth').client))).toBe('paused');
    expect((await db.query('SELECT status FROM mail_accounts WHERE id = 1')).rows[0].status).toBe('revoked');
    const waiting = await db.query(`SELECT e.status FROM boq_emails e JOIN boqs b ON b.id = e.boq_id JOIN projects p ON p.id = b.project_id WHERE p.name = $1 AND e.status = 'queued'`, [`${tag} project`]);
    expect(waiting.rowCount).toBe(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM notifications WHERE type = 'gmail_disconnected' AND created_at >= $1`, [startedAt])).rows[0].n).toBeGreaterThan(0);
    expect(await processOne(deps(fakeGmail('ok').client))).toBe('paused');
    // reconnecting resumes it
    await connect();
    expect(await processOne(deps(fakeGmail('ok').client))).toBe('sent');
  });

  it('an interrupted send that Gmail already delivered is marked sent, not failed', async () => {
    await connect();
    const id = await makeBoq(A);
    const boq = (await db.query('SELECT boq_no FROM boqs WHERE id = $1', [id])).rows[0];
    const stuck = await db.query(
      `INSERT INTO boq_emails (boq_id, boq_no, revision, sent_by, client_id, to_addrs, subject, body_text, currency_choice,
                               tag, reply_to, rfc_message_id, status, claimed_at)
       VALUES ($1, $2, 0, $3, $4, $5, 'Interrupted', 'hi', 'BDT', 't', 'r', $6, 'sending', now() - interval '20 minutes')
       RETURNING id`,
      [id, boq.boq_no, A.id, clientId, ['client@example.com'], `<interrupted-${tag}@x>`]);
    await db.query(`UPDATE boqs SET status = 'sent' WHERE id = $1`, [id]);

    const fake = {
      async findByMessageId() { return { id: 'already-delivered', threadId: 'th-9' }; },
      async listMessages() { return { messages: [{ id: 'already-delivered', threadId: 'th-9' }] }; },
      async send() { return { id: 'x', threadId: 'y' }; },
      async headers() { return {}; },
    } as unknown as GmailClient;

    await recoverStuck(deps(fake));
    expect((await db.query('SELECT status, gmail_message_id FROM boq_emails WHERE id = $1', [stuck.rows[0].id])).rows[0])
      .toMatchObject({ status: 'sent', gmail_message_id: 'already-delivered' });
    expect((await db.query('SELECT sent_at FROM boqs WHERE id = $1', [id])).rows[0].sent_at).not.toBeNull();
  });
});

describe('Sending the workbook the estimator edited in Excel', () => {
  /** Earlier tests leave due queue rows behind; drain them so the assertions below see only this test's send. */
  async function drain() {
    const g = fakeGmail('ok');
    for (let i = 0; i < 20; i++) if ((await processOne(deps(g.client))) === 'idle') return;
  }

  it('stores the upload as a manual export, records its hash and sends it as the only attachment', async () => {
    await connect();
    await drain();
    const id = await makeBoq(A);
    const buf = await xlsx(['Offer Summary', 'Imported Item']);
    await queueSend(A, id, input(), { buf, fileName: 'My edited offer.xlsx' });

    const ex = (await db.query(`SELECT source, original_name, sha256, with_costing, file_name FROM boq_exports WHERE boq_id = $1`, [id])).rows[0];
    expect(ex).toMatchObject({ source: 'manual', original_name: 'My edited offer.xlsx', with_costing: false, file_name: 'My edited offer.xlsx' });
    expect(ex.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.query('SELECT status FROM boqs WHERE id = $1', [id])).rows[0].status).toBe('sent');

    const g = fakeGmail('ok');
    expect(await processOne(deps(g.client))).toBe('sent');
    expect(g.sent[0] ?? '').toContain('My edited offer.xlsx');
    expect(((g.sent[0] ?? '').match(/Content-Disposition: attachment/g) ?? []).length).toBe(1);

    const emails = await db.query(`SELECT e.export_ids FROM boq_emails e WHERE e.boq_id = $1`, [id]);
    expect(emails.rows[0].export_ids).toHaveLength(1);
    expect((await emailsForBoq(id)).some((e) => e.manual)).toBe(true);
  });

  it('refuses a file with the internal costing sheet and leaves the BOQ in draft', async () => {
    await connect();
    const id = await makeBoq(A);
    const buf = await xlsx(['Offer Summary', 'Costing (internal)']);
    await expect(queueSend(A, id, input(), { buf, fileName: 'with costing.xlsx' })).rejects.toMatchObject({ status: 400 });
    expect((await db.query('SELECT status FROM boqs WHERE id = $1', [id])).rows[0].status).toBe('draft');
    expect((await db.query('SELECT count(*)::int AS n FROM boq_emails WHERE boq_id = $1', [id])).rows[0].n).toBe(0);
  });

  it('refuses something that is not an .xlsx workbook', async () => {
    await connect();
    const id = await makeBoq(A);
    await expect(queueSend(A, id, input(), { buf: Buffer.from('not a workbook'), fileName: 'notes.xlsx' })).rejects.toMatchObject({ status: 400 });
  });

  it('is not blocked by the app lines having a 0 rate', async () => {
    await connect();
    const zero = await makeBoq(A, { unpriced: true });
    const pre = await sendPreflight(A, zero);
    expect(pre.blockers.join(' ')).toMatch(/rate of 0/);
    expect(pre.blockersUpload).toEqual([]);
    const buf = await xlsx(['Offer Summary']);
    await queueSend(A, zero, input(), { buf, fileName: 'edited.xlsx' });
    expect(await processOne(deps(fakeGmail('ok').client))).toBe('sent');
  });
});
