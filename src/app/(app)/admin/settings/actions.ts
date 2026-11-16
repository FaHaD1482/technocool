'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { can, getCurrentUser } from '@/lib/auth/session';
import { tx } from '@/lib/db';
import { firstIssue } from '@/lib/forms';

export type CompanyState = { error?: string; ok?: string };

const opt = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);
const Schema = z.object({
  companyName: z.string().trim().min(2, 'Enter the company name').max(200),
  address: opt(500),
  phone: opt(50),
  email: z.string().trim().toLowerCase().max(200).optional().transform((v) => v || null)
    .refine((v) => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'E-mail is not valid'),
  vatRegNo: opt(50),
});

export async function saveCompanySettings(_prev: CompanyState, form: FormData): Promise<CompanyState> {
  const u = await getCurrentUser();
  if (!u || !can(u, 'settings.company.manage')) return { error: 'You do not have permission to change company settings.' };
  const p = Schema.safeParse(Object.fromEntries(form.entries()));
  if (!p.success) return { error: firstIssue(p.error) };
  const d = p.data;
  await tx(u.id, (db) => db.query(
    `UPDATE company_settings SET company_name = $1, address = $2, phone = $3, email = $4, vat_reg_no = $5, updated_by = $6 WHERE id = 1`,
    [d.companyName, d.address, d.phone, d.email, d.vatRegNo, u.id]));
  revalidatePath('/admin/settings');
  revalidatePath('/admin/gmail');
  return { ok: 'Saved. New e-mails and offers use these details.' };
}
