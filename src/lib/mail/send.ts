import 'server-only';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { ApiError } from '@/lib/api';
import type { SessionUser } from '@/lib/auth/session';
import { calculate } from '@/lib/calc';
import { editorPermissions, getVisibleBoq, loadBoqForServer } from '@/lib/boq/repo';
import { toCalcRow, toCalcSettings } from '@/lib/boq/rows';
import type { ExportChoice } from '@/lib/boq/types';
import { query, tx } from '@/lib/db';
import { buildExports, exportPaths, filePath, persistExports, storeUploadedExport, type ExportResult } from '@/lib/excel/export';
import { dailyUsage, getMailStatus } from './account';
import { currencyNote, fillTemplate, messageIdFor, parseRecipients, plusAddress, subjectCode, tagFor, withSubjectCode } from './compose';
import { ensureBoqThread } from './threads';

/** Gmail accepts about 35 MB of raw MIME; base64 makes the file ~1.33x bigger, so keep the upload well below it. */
export const MAX_UPLOAD_MB = 15;

export interface SendPreflight {
  blockers: string[];
  /** Same checks with the estimator's own file attached (no zero-rate / empty-offer blocks). */
  blockersUpload: string[];
  warnings: string[];
  mailbox: string | null;
  replyTo: string | null;
  to: string;
  subject: string;
  body: string;
  currency: ExportChoice;
  code: string;
  daily: { used: number; limit: number };
  maxUploadMb: number;
}

async function context(u: SessionUser, boqId: string) {
  const b = await getVisibleBoq(u, boqId);
  const perms = editorPermissions(u, b);
  const [data, mail, daily, extra] = await Promise.all([
    loadBoqForServer(boqId), getMailStatus(), dailyUsage(),
    query(`SELECT c.contact_person, c.name AS client_name, c.email AS client_email, (c.deleted_at IS NOT NULL) AS client_deleted,
                  s.company_name, s.email_subject_template, s.email_body_template, s.email_from_name,
                  me.full_name, me.designation, me.phone
           FROM boqs b JOIN projects p ON p.id = b.project_id LEFT JOIN clients c ON c.id = p.client_id
           CROSS JOIN company_settings s JOIN app_users me ON me.id = $2
           WHERE b.id = $1 AND s.id = 1`, [boqId, u.id]),
  ]);
  const calc = calculate(data.rows.map(toCalcRow), toCalcSettings(data.settings));
  const inOffer = data.rows.filter((r) => { const it = calc.items.get(r.key)!; return it.countsInOffer && it.qty.gt(0); });
  const zero = inOffer.filter((r) => calc.items.get(r.key)!.rate.isZero());
  return { b, perms, data, mail, daily, x: extra.rows[0], inOffer, zero };
}

function blockersFor(c: Awaited<ReturnType<typeof context>>, u: SessionUser, manual = false): string[] {
  const out: string[] = [];
  if (!u.permissions.has('boq.send')) out.push('Your role cannot send BOQs.');
  else if (c.b.owner_user_id !== u.id) out.push('Only the owner of this BOQ can send it.');
  else if (c.b.status !== 'draft') out.push(`This BOQ is already ${c.b.status}. Create a new revision to send a changed offer.`);
  if (!c.mail.configured) out.push('Gmail is not set up on the server yet (Google client id and secret are missing).');
  else if (!c.mail.connected) out.push(c.mail.status === 'revoked' ? 'Gmail was disconnected. Ask the admin to reconnect it.' : 'The company Gmail is not connected yet. Ask the admin to connect it.');
  // A removed (soft-deleted) client should not receive new offers.
  if (c.x?.client_deleted) out.push('This client was removed from the client list. Restore it or choose another client.');
  // The upload is the estimator's own file, so the app's lines (and their rates) do not describe it.
  if (!manual) {
    if (!c.inOffer.length) out.push('Add a quantity to at least one item first.');
    if (c.zero.length) {
      const names = c.zero.slice(0, 5).map((r) => r.model || r.description).join(', ');
      out.push(`${c.zero.length} line${c.zero.length > 1 ? 's have' : ' has'} a rate of 0 (no price): ${names}${c.zero.length > 5 ? '…' : ''}. Add the cost before sending.`);
    }
  }
  if (c.daily.used >= c.daily.limit) out.push(`Today's sending limit is reached (${c.daily.used} of ${c.daily.limit} recipients). Try again tomorrow.`);
  return out;
}

export async function sendPreflight(u: SessionUser, boqId: string): Promise<SendPreflight> {
  const c = await context(u, boqId);
  const { header, settings } = c.data;
  const code = subjectCode(header.boqNo, header.revision);
  const currency: ExportChoice = settings.offerCurrency;
  const vars = {
    contact: c.x.contact_person || c.x.client_name || 'Sir/Madam', client: c.x.client_name, project: header.projectName,
    code, boq_no: header.boqNo, revision: `R${header.revision}`, currency_note: currencyNote(currency),
    sender_name: c.x.full_name, sender_designation: c.x.designation, sender_phone: c.x.phone, company: c.x.company_name,
  };
  const warnings: string[] = [];
  if (!c.x.client_email) warnings.push('This client has no e-mail saved. Type the address below.');
  if (c.daily.used >= c.daily.limit * 0.8) warnings.push(`Near today's sending limit: ${c.daily.used} of ${c.daily.limit} recipients used.`);
  return {
    blockers: blockersFor(c, u),
    blockersUpload: blockersFor(c, u, true),
    warnings,
    mailbox: c.mail.email,
    replyTo: c.mail.email ? plusAddress(c.mail.email, tagFor(header.boqNo, header.revision)) : null,
    to: c.x.client_email ?? '',
    subject: withSubjectCode(fillTemplate(c.x.email_subject_template, vars), header.boqNo, header.revision),
    body: fillTemplate(c.x.email_body_template, vars),
    currency,
    code,
    daily: c.daily,
    maxUploadMb: MAX_UPLOAD_MB,
  };
}

const noBreak = (s: string) => !/[\r\n]/.test(s);
export const SendSchema = z.object({
  to: z.string().max(1000),
  cc: z.string().max(1000).default(''),
  subject: z.string().trim().min(3, 'Enter a subject').max(250).refine(noBreak),
  body: z.string().trim().min(1, 'Write a message').max(20000),
  currency: z.enum(['BDT', 'USD', 'BOTH']),
  attachment: z.enum(['generated', 'upload']).default('generated'),
});
export type SendInput = z.infer<typeof SendSchema>;

/**
 * Queues the e-mail. The lock, the "sent" status, the Excel file rows and the queue row all happen in ONE
 * transaction, so a crash can never leave a BOQ marked Sent with no mail queued. The workbook(s) are built in
 * memory first (no DB, no files); the files are written inside the transaction and removed if it rolls back.
 */
export async function queueSend(u: SessionUser, boqId: string, input: SendInput, upload?: { buf: Buffer; fileName: string }) {
  const manual = !!upload;
  const to = parseRecipients(input.to), cc = parseRecipients(input.cc);
  if (to.bad.length || cc.bad.length) throw new ApiError(400, `Not a valid e-mail address: ${[...to.bad, ...cc.bad].join(', ')}`);
  if (!to.ok.length) throw new ApiError(400, 'Add at least one recipient.');
  if (to.ok.length > 10 || cc.ok.length > 10) throw new ApiError(400, 'At most 10 addresses in To and 10 in Cc.');

  const c = await context(u, boqId);
  const blockers = blockersFor(c, u, manual);
  if (blockers.length) throw new ApiError(409, blockers[0] ?? 'This BOQ cannot be sent yet.', 'send_blocked');
  if (c.daily.used + to.ok.length + cc.ok.length > c.daily.limit) throw new ApiError(409, 'This would go over today\'s sending limit.', 'send_blocked');
  const { header } = c.data;
  const mailbox = c.mail.email!;
  if ([...to.ok, ...cc.ok].includes(mailbox.toLowerCase())) throw new ApiError(400, 'Do not send the offer to the company mailbox itself.');

  // One uploaded file has no BDT/USD choice of its own: record the BOQ's currency instead.
  const uploadedCurrency = c.data.settings.offerCurrency;
  const built = manual ? null : await buildExports(u, boqId, input.currency, { withCosting: false, forClient: true });
  const written: string[] = [];

  try {
    return await tx(u.id, async (db) => {
      // 1. lock the row and mark it Sent
      const { rows: locked } = await db.query('SELECT status, owner_user_id FROM boqs WHERE id = $1 FOR UPDATE', [boqId]);
      if (locked[0]?.status !== 'draft' || locked[0]?.owner_user_id !== u.id) {
        throw new ApiError(409, 'This BOQ was sent or changed a moment ago. Reload the page.', 'send_blocked');
      }
      await db.query(`UPDATE boqs SET status = 'sent', updated_by = $2 WHERE id = $1`, [boqId, u.id]);

      // 2. the client-safe file(s) and their boq_exports rows, in the same transaction
      let files: ExportResult[];
      if (manual) {
        const one = await storeUploadedExport(db, u, boqId, upload!, uploadedCurrency);
        written.push(filePath(boqId, one.id));
        files = [one];
      } else {
        files = await persistExports(u, db, boqId, built!, false);
        written.push(...exportPaths(boqId, built!.files));
      }

      // 3. the queue row (the worker sends it)
      const tag = tagFor(header.boqNo, header.revision);
      const subject = withSubjectCode(input.subject, header.boqNo, header.revision);
      const { rows } = await db.query(
        `INSERT INTO boq_emails (boq_id, boq_no, revision, sent_by, client_id, to_addrs, cc_addrs, subject, body_text, currency_choice,
                                 export_ids, tag, reply_to, rfc_message_id, from_addr)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
        [boqId, header.boqNo, header.revision, u.id, header.clientId, to.ok, cc.ok, subject, input.body, manual ? uploadedCurrency : input.currency,
          files.map((f) => f.id), tag, plusAddress(mailbox, tag), messageIdFor(tag), mailbox]);
      // The Inbox shows every BOQ conversation too; the thread keeps one entry per BOQ number.
      const threadId = await ensureBoqThread(db, {
        boqId, boqNo: header.boqNo, clientId: header.clientId ?? null, ownerId: u.id, tag, subject,
      });
      await db.query(`UPDATE boq_emails SET thread_id = $2 WHERE id = $1`, [rows[0].id, threadId]);
      await db.query(`SELECT pg_notify('boq_mail', $1)`, [rows[0].id]);
      return { emailId: rows[0].id as string, subject, files: files.map((f) => f.fileName) };
    });
  } catch (e) {
    // The transaction rolled back; remove any file it had already written.
    await Promise.all(written.map((p) => rm(p, { force: true }).catch(() => {})));
    throw e;
  }
}

export interface EmailSummary {
  id: string; to: string[]; cc: string[]; subject: string; status: 'queued' | 'sending' | 'sent' | 'failed';
  attempts: number; lastError: string | null; queuedAt: string; sentAt: string | null; currency: string; sender: string | null;
  manual: boolean;
}

/** Sends of one BOQ (the caller has already checked the user may see it). */
export async function emailsForBoq(boqId: string): Promise<EmailSummary[]> {
  const { rows } = await query(`
    SELECT e.id, e.to_addrs, e.cc_addrs, e.subject, e.status, e.attempts, e.last_error, e.queued_at, e.sent_at, e.currency_choice, u.full_name,
           EXISTS (SELECT 1 FROM boq_exports x WHERE x.id = ANY(e.export_ids) AND x.source = 'manual') AS manual
    FROM boq_emails e LEFT JOIN app_users u ON u.id = e.sent_by WHERE e.boq_id = $1 ORDER BY e.queued_at DESC`, [boqId]);
  return rows.map((r) => ({
    id: r.id, to: r.to_addrs, cc: r.cc_addrs, subject: r.subject, status: r.status, attempts: r.attempts, lastError: r.last_error,
    queuedAt: r.queued_at.toISOString(), sentAt: r.sent_at?.toISOString() ?? null, currency: r.currency_choice, sender: r.full_name,
    manual: r.manual,
  }));
}
