/**
 * Send worker: takes one queued row at a time — a BOQ send (`boq_emails`) or a general client message
 * (`mail_messages`) — and sends it through the company Gmail.
 * This is the only code that decrypts the Gmail refresh token.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { assertClientSafeFile } from '@/lib/excel/safety';
import { readStoredAttachment, validateStored, type StoredAttachment } from '@/lib/mail/attachments';
import { decryptSecret, SecretError } from '@/lib/mail/crypto';
import { GmailApiError, GmailAuthError, type GmailClient } from '@/lib/mail/gmail';
import { buildMime, textToHtml } from '@/lib/mail/mime';

export interface WorkerDeps {
  pool: pg.Pool;
  makeClient: (refreshToken: string) => GmailClient;
  storageDir: string;
  log?: (msg: string) => void;
}
export type StepResult = 'idle' | 'sent' | 'retry' | 'failed' | 'paused';

const BACKOFF_MIN = [1, 5, 15];            // minutes before attempt 2, 3, 4
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Cached so the access token is reused between mails; rebuilt when the refresh token changes. */
let cached: { enc: string; client: GmailClient } | null = null;

class PermanentError extends Error {}

interface Job {
  source: 'boq' | 'mail';
  row: Record<string, any>;
  threadId: string | null;
}

export async function withUser<T>(pool: pg.Pool, userId: string | null, fn: (c: pg.PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    if (userId) await c.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function notify(
  c: pg.PoolClient, userId: string, type: string, boqId: string | null, title: string, body: string | null, threadId: string | null = null,
) {
  await c.query(`INSERT INTO notifications (user_id, type, boq_id, thread_id, title, body) VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, type, boqId, threadId, title, body]);
}

/** BOQ back to draft after a failed send, unless another send of it went out. */
async function unlockBoq(c: pg.PoolClient, boqId: string) {
  await c.query(`UPDATE boqs SET status = 'draft', sent_at = NULL
                 WHERE id = $1 AND status = 'sent' AND NOT EXISTS (SELECT 1 FROM boq_emails WHERE boq_id = $1 AND status IN ('sent', 'sending', 'queued'))`, [boqId]);
}

/**
 * A send left in "sending" because the worker died may already be in Gmail's Sent folder. Asking Gmail before
 * declaring it failed stops the client from receiving the same offer twice.
 */
async function alreadyDelivered(deps: WorkerDeps, acc: any, messageId: string | null) {
  if (!acc || acc.status !== 'connected' || !messageId) return null;
  try {
    return await gmailFor(deps, acc.refresh_token_enc).findByMessageId(messageId);
  } catch (e) {
    deps.log?.(`could not check the Sent folder: ${(e as Error).message}`);
    return null;
  }
}

/** Sends left in "sending" for 10 minutes are reconciled with Gmail, then marked failed with a warning. */
export async function recoverStuck(deps: WorkerDeps) {
  const acc = (await deps.pool.query('SELECT status, refresh_token_enc FROM mail_accounts WHERE id = 1')).rows[0];

  const { rows } = await deps.pool.query(`SELECT id, boq_id, sent_by, subject, rfc_message_id FROM boq_emails WHERE status = 'sending' AND claimed_at < now() - interval '10 minutes'`);
  for (const r of rows) {
    const found = await alreadyDelivered(deps, acc, r.rfc_message_id);
    if (found) {
      await withUser(deps.pool, r.sent_by, async (c) => {
        await c.query(`UPDATE boq_emails SET status = 'sent', gmail_message_id = $2, gmail_thread_id = $3, sent_at = now(), last_error = NULL WHERE id = $1 AND status = 'sending'`,
          [r.id, found.id, found.threadId]);
        await c.query(`UPDATE boqs SET sent_at = now() WHERE id = $1`, [r.boq_id]);
        await notify(c, r.sent_by, 'send_succeeded', r.boq_id, `Sent ${r.subject}`, 'The send had been interrupted, but Gmail already delivered it.');
      });
      deps.log?.(`stuck send ${r.id} was already delivered; marked sent`);
      continue;
    }
    await withUser(deps.pool, r.sent_by, async (c) => {
      await c.query(`UPDATE boq_emails SET status = 'failed', last_error = $2 WHERE id = $1 AND status = 'sending'`,
        [r.id, 'Interrupted while sending. Check the Sent folder of the company Gmail before sending again.']);
      await unlockBoq(c, r.boq_id);
      await notify(c, r.sent_by, 'send_failed', r.boq_id, `Not sure “${r.subject}” was sent`, 'The send was interrupted. Ask the admin to check the Sent folder before sending again.');
    });
    deps.log?.(`recovered stuck send ${r.id}`);
  }

  const mails = await deps.pool.query(`SELECT id, sent_by, subject, thread_id, rfc_message_id FROM mail_messages WHERE status = 'sending' AND claimed_at < now() - interval '10 minutes'`);
  for (const r of mails.rows) {
    const found = await alreadyDelivered(deps, acc, r.rfc_message_id);
    if (found) {
      await withUser(deps.pool, r.sent_by, async (c) => {
        await c.query(`UPDATE mail_messages SET status = 'sent', gmail_message_id = $2, gmail_thread_id = $3, sent_at = now(), last_error = NULL WHERE id = $1 AND status = 'sending'`,
          [r.id, found.id, found.threadId]);
        if (r.thread_id) {
          await c.query(`UPDATE mail_threads SET gmail_thread_id = coalesce(gmail_thread_id, $2), last_message_at = now() WHERE id = $1`, [r.thread_id, found.threadId]);
        }
        await notify(c, r.sent_by, 'message_sent', null, `Sent “${r.subject}”`, 'The send had been interrupted, but Gmail already delivered it.', r.thread_id);
      });
      deps.log?.(`stuck message ${r.id} was already delivered; marked sent`);
      continue;
    }
    await withUser(deps.pool, r.sent_by, async (c) => {
      await c.query(`UPDATE mail_messages SET status = 'failed', last_error = $2 WHERE id = $1 AND status = 'sending'`,
        [r.id, 'Interrupted while sending. Check the Sent folder of the company Gmail before sending again.']);
      await notify(c, r.sent_by, 'message_failed', null, `Not sure “${r.subject}” was sent`, 'The send was interrupted. Ask the admin to check the Sent folder before sending again.', r.thread_id);
    });
    deps.log?.(`recovered stuck message ${r.id}`);
  }
}

/** General messages first, then BOQ sends; both use the same back-off rule. */
async function claimNext(pool: pg.Pool): Promise<Job | null> {
  const mail = (await pool.query(`
    UPDATE mail_messages SET status = 'sending', claimed_at = now(), attempts = attempts + 1
    WHERE id = (SELECT id FROM mail_messages WHERE status = 'queued' AND not_before <= now() ORDER BY not_before FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`)).rows[0];
  if (mail) return { source: 'mail', row: mail, threadId: mail.thread_id };

  const boq = (await pool.query(`
    UPDATE boq_emails SET status = 'sending', claimed_at = now(), attempts = attempts + 1
    WHERE id = (SELECT id FROM boq_emails WHERE status = 'queued' AND not_before <= now() ORDER BY not_before FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING *`)).rows[0];
  if (boq) return { source: 'boq', row: boq, threadId: boq.thread_id ?? null };

  return null;
}

async function attachmentsFor(deps: WorkerDeps, job: Job): Promise<{ filename: string; contentType: string; content: Buffer }[]> {
  const { pool } = deps;
  const row = job.row;

  if (job.source === 'boq') {
    // Must be this BOQ's exports, made without costing, and still pass the sheet check.
    const ex = (await pool.query(`SELECT id, boq_id, file_name, file_url, with_costing FROM boq_exports WHERE id = ANY($1::uuid[])`, [row.export_ids])).rows;
    if (ex.length !== row.export_ids.length || !ex.length) throw new PermanentError('An attached Excel file is missing. Send again.');
    const out = [];
    for (const e of ex) {
      if (e.with_costing || e.boq_id !== row.boq_id) throw new PermanentError('Refusing to send: an attachment is not a client file of this BOQ.');
      if (!e.file_url) throw new PermanentError(`The file ${e.file_name} is no longer stored. Send again.`);
      const full = path.resolve(deps.storageDir, e.file_url);
      if (!full.startsWith(path.resolve(deps.storageDir) + path.sep)) throw new PermanentError('Bad attachment path.');
      const content = await readFile(full).catch(() => { throw new PermanentError(`The file ${e.file_name} is no longer stored. Send again.`); });
      await assertClientSafeFile(content).catch((err) => { throw new PermanentError(err.message); });
      out.push({ filename: e.file_name, contentType: XLSX, content });
    }
    return out;
  }

  let stored: StoredAttachment[] = [];
  try { stored = validateStored(row.attachments); } catch (e) { throw new PermanentError((e as Error).message); }
  const out = [];
  for (const a of stored) {
    const content = await readStoredAttachment(a.path).catch(() => { throw new PermanentError(`The file ${a.filename} is no longer stored. Send again.`); });
    // A general e-mail may not carry a workbook with the internal costing sheet (policy: costing never leaves).
    if (a.mimeType === XLSX) await assertClientSafeFile(content).catch((err) => { throw new PermanentError(err.message); });
    out.push({ filename: a.filename, contentType: a.mimeType, content });
  }
  return out;
}

export async function processOne(deps: WorkerDeps): Promise<StepResult> {
  const { pool } = deps;
  const acc = (await pool.query(`SELECT m.email, m.refresh_token_enc, m.status, coalesce(s.email_from_name, s.company_name) AS from_name
                                 FROM mail_accounts m CROSS JOIN company_settings s WHERE m.id = 1 AND s.id = 1`)).rows[0];
  if (!acc || acc.status !== 'connected') return 'paused';
  // Never show the seeded placeholder ("Your company name (edit in Settings)") to a client.
  const fromName = acc.from_name && !/^your company name/i.test(acc.from_name) ? acc.from_name : null;

  const job = await claimNext(pool);
  if (!job) return 'idle';
  const row = job.row;
  const label = job.source === 'boq' ? `${row.boq_no} R${row.revision}` : `“${row.subject}”`;

  // Once Gmail has accepted the mail it must never be retried, whatever fails afterwards.
  let delivered: { id: string; threadId: string } | null = null;
  try {
    const attachments = await attachmentsFor(deps, job);

    const headers: Record<string, string> = {};
    if (job.source === 'boq') headers['X-BOQ-Ref'] = `${row.boq_no} R${row.revision}`;
    else {
      if (row.in_reply_to) headers['In-Reply-To'] = row.in_reply_to;
      if (row.references_hdr) headers['References'] = row.references_hdr;
    }

    const raw = buildMime({
      from: { name: fromName, address: acc.email }, to: row.to_addrs, cc: row.cc_addrs, replyTo: row.reply_to,
      subject: row.subject, text: row.body_text, html: textToHtml(row.body_text), messageId: row.rfc_message_id,
      headers, attachments,
    });

    const gmail = gmailFor(deps, acc.refresh_token_enc);
    const sent = row.gmail_thread_id ? await gmail.sendInThread(raw, row.gmail_thread_id) : await gmail.send(raw);
    delivered = sent;

    // Gmail can replace the Message-ID; store the one replies will quote.
    let rfcId = row.rfc_message_id as string;
    try { rfcId = (await gmail.headers(sent.id, ['Message-ID']))['message-id'] || rfcId; } catch { /* keep ours */ }

    if (job.source === 'boq') {
      await withUser(pool, row.sent_by, async (c) => {
        await c.query(`UPDATE boq_emails SET status = 'sent', gmail_message_id = $2, gmail_thread_id = $3, rfc_message_id = $4, sent_at = now(), last_error = NULL WHERE id = $1`,
          [row.id, sent.id, sent.threadId, rfcId]);
        await c.query(`UPDATE boqs SET sent_at = now() WHERE id = $1`, [row.boq_id]);
        await c.query(`UPDATE projects SET status = 'quoted' WHERE id = (SELECT project_id FROM boqs WHERE id = $1) AND status = 'lead'`, [row.boq_id]);
        if (job.threadId) await c.query(`UPDATE mail_threads SET gmail_thread_id = coalesce(gmail_thread_id, $2), last_message_at = now() WHERE id = $1`, [job.threadId, sent.threadId]);
        await notify(c, row.sent_by, 'send_succeeded', row.boq_id, `Sent ${row.boq_no} R${row.revision}`, `To ${row.to_addrs.join(', ')}`, job.threadId);
      });
    } else {
      await withUser(pool, row.sent_by, async (c) => {
        await c.query(`UPDATE mail_messages SET status = 'sent', gmail_message_id = $2, gmail_thread_id = $3, rfc_message_id = $4, sent_at = now(), last_error = NULL WHERE id = $1`,
          [row.id, sent.id, sent.threadId, rfcId]);
        if (job.threadId) await c.query(`UPDATE mail_threads SET gmail_thread_id = coalesce(gmail_thread_id, $2), last_message_at = now() WHERE id = $1`, [job.threadId, sent.threadId]);
        await notify(c, row.sent_by, 'message_sent', null, `Sent “${row.subject}”`, `To ${row.to_addrs.join(', ')}`, job.threadId);
      });
    }
    deps.log?.(`sent ${label} (${row.id})`);
    return 'sent';
  } catch (err) {
    const msg = (err as Error).message?.slice(0, 500) ?? 'Unknown error';

    if (delivered) {
      if (job.source === 'boq') {
        await pool.query(`UPDATE boq_emails SET status = 'sent', gmail_message_id = $2, gmail_thread_id = $3, sent_at = now(), last_error = $4 WHERE id = $1`,
          [row.id, delivered.id, delivered.threadId, `Sent, but some details were not saved: ${msg}`]).catch(() => {});
      } else {
        await pool.query(`UPDATE mail_messages SET status = 'sent', gmail_message_id = $2, gmail_thread_id = $3, sent_at = now(), last_error = $4 WHERE id = $1`,
          [row.id, delivered.id, delivered.threadId, `Sent, but some details were not saved: ${msg}`]).catch(() => {});
      }
      deps.log?.(`sent ${row.id} but recording failed: ${msg}`);
      return 'sent';
    }

    if (err instanceof GmailAuthError || err instanceof SecretError) {
      // Pause everything until the admin reconnects (or pastes the right key); this mail waits in the queue.
      const table = job.source === 'boq' ? 'boq_emails' : 'mail_messages';
      await pool.query(`UPDATE ${table} SET status = 'queued', attempts = greatest(attempts - 1, 0), last_error = $2 WHERE id = $1`, [row.id, msg]);
      await pauseForAuth(deps, msg);
      return 'paused';
    }

    const retryable = err instanceof GmailApiError ? err.retryable : !(err instanceof PermanentError);
    if (retryable && row.attempts < MAX_ATTEMPTS) {
      const table = job.source === 'boq' ? 'boq_emails' : 'mail_messages';
      await pool.query(`UPDATE ${table} SET status = 'queued', last_error = $2, not_before = now() + make_interval(mins => $3) WHERE id = $1`,
        [row.id, msg, BACKOFF_MIN[row.attempts - 1]]);
      deps.log?.(`send ${row.id} failed (attempt ${row.attempts}), will retry: ${msg}`);
      return 'retry';
    }

    if (job.source === 'boq') {
      await withUser(pool, row.sent_by, async (c) => {
        await c.query(`UPDATE boq_emails SET status = 'failed', last_error = $2 WHERE id = $1`, [row.id, msg]);
        await unlockBoq(c, row.boq_id);
        await notify(c, row.sent_by, 'send_failed', row.boq_id, `Could not send ${row.boq_no} R${row.revision}`, msg, job.threadId);
      });
    } else {
      await withUser(pool, row.sent_by, async (c) => {
        await c.query(`UPDATE mail_messages SET status = 'failed', last_error = $2 WHERE id = $1`, [row.id, msg]);
        await notify(c, row.sent_by, 'message_failed', null, `Could not send “${row.subject}”`, msg, job.threadId);
      });
    }
    deps.log?.(`send ${row.id} failed for good: ${msg}`);
    return 'failed';
  }
}

/** One Gmail client per refresh token, so the access token is reused across mails and reply checks. */
export function gmailFor(deps: WorkerDeps, enc: Buffer): GmailClient {
  const key = enc.toString('base64');
  if (!cached || cached.enc !== key) cached = { enc: key, client: deps.makeClient(decryptSecret(enc)) };
  return cached.client;
}

/** Google revoked access: mark the connection, alert the admins once, and stop until reconnected. */
export async function pauseForAuth(deps: WorkerDeps, msg: string) {
  await withUser(deps.pool, null, async (c) => {
    const changed = await c.query(`UPDATE mail_accounts SET status = 'revoked', status_detail = $1 WHERE id = 1 AND status = 'connected' RETURNING 1`, [msg]);
    if (changed.rowCount) {
      for (const id of await usersWith(c, 'integrations.gmail.manage')) {
        await notify(c, id, 'gmail_disconnected', null, 'Gmail is disconnected: sending and replies are paused', msg);
      }
    }
  });
  cached = null;
  deps.log?.(`gmail auth failed, paused: ${msg}`);
}

export async function usersWith(c: pg.PoolClient, permission: string): Promise<string[]> {
  const { rows } = await c.query(`SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
                                  JOIN app_users u ON u.id = ur.user_id AND u.is_active WHERE rp.permission_code = $1`, [permission]);
  return rows.map((r) => r.user_id as string);
}

/** Test hook. */
export function resetClientCache() { cached = null; }
