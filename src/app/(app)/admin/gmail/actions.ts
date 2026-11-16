'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { can, getCurrentUser } from '@/lib/auth/session';
import { actionError } from '@/lib/action-error';
import { tx } from '@/lib/db';
import { firstIssue } from '@/lib/forms';
import { deleteConnection } from '@/lib/mail/account';
import { clearMailConfig, saveMailConfig } from '@/lib/mail/config';
import { decryptSecret } from '@/lib/mail/crypto';
import { revokeToken } from '@/lib/mail/gmail';

export type TplState = { error?: string; ok?: string };
export type CfgState = { error?: string; ok?: string };

async function admin() {
  const u = await getCurrentUser();
  if (!u || !can(u, 'integrations.gmail.manage')) throw new Error('Only the admin can change the Gmail connection.');
  return u;
}

export async function disconnectGmail() {
  const u = await admin();
  const enc = await deleteConnection(u.id);
  // Tell Google too, so the token is dead everywhere.
  if (enc) { try { await revokeToken(decryptSecret(enc)); } catch { /* already invalid */ } }
  revalidatePath('/admin/gmail');
}

const Tpl = z.object({
  fromName: z.string().trim().max(100).refine((v) => !/[\r\n<>"]/.test(v), 'No line breaks or < > " in the sender name'),
  subject: z.string().trim().min(3).max(200).refine((v) => !/[\r\n]/.test(v), 'The subject must be one line'),
  body: z.string().trim().min(10).max(5000),
});

export async function saveTemplate(_prev: TplState, form: FormData): Promise<TplState> {
  try {
    const u = await admin();
    const p = Tpl.safeParse(Object.fromEntries(form.entries()));
    if (!p.success) return { error: firstIssue(p.error) };
    await tx(u.id, (db) => db.query(
      `UPDATE company_settings SET email_from_name = NULLIF($1, ''), email_subject_template = $2, email_body_template = $3, updated_by = $4 WHERE id = 1`,
      [p.data.fromName, p.data.subject, p.data.body, u.id]));
    revalidatePath('/admin/gmail');
    return { ok: 'Template saved. New sends use it.' };
  } catch (e) {
    return { error: actionError(e) };
  }
}

const Cfg = z.object({
  clientId: z.string().trim().min(10, 'Paste the Google client ID').max(300),
  clientSecret: z.string().trim().max(300).optional().default(''),
  mailbox: z.string().trim().toLowerCase().email('Enter the company Gmail address').max(200),
  redirectUri: z.string().trim().max(500).url('The redirect URI must be a full URL')
    .refine((v) => v.endsWith('/api/integrations/gmail/callback'), 'The redirect URI must end with /api/integrations/gmail/callback'),
});

/**
 * Saves the Google OAuth client in the app (no .env.local edit, no restart). A blank secret keeps the stored one.
 * `intent=clear` removes the saved settings and falls back to .env.local.
 */
export async function saveGmailSettings(_prev: CfgState, form: FormData): Promise<CfgState> {
  try {
    const u = await admin();
    if (form.get('intent') === 'clear') {
      await clearMailConfig(u.id);
      revalidatePath('/admin/gmail');
      return { ok: 'Saved settings removed. The app falls back to .env.local if it is set.' };
    }
    const p = Cfg.safeParse(Object.fromEntries(form.entries()));
    if (!p.success) return { error: firstIssue(p.error) };
    await saveMailConfig(u.id, p.data);
    revalidatePath('/admin/gmail');
    return { ok: 'Saved. Press Connect Gmail (or Reconnect) to use these settings.' };
  } catch (e) {
    return { error: actionError(e) };
  }
}
