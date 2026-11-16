'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { can, getCurrentUser } from '@/lib/auth/session';
import { tx } from '@/lib/db';
import { firstIssue } from '@/lib/forms';

export type NewBoqState = { error?: string; fields?: Record<string, string> };

const opt = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);
const Schema = z.object({
  clientMode: z.enum(['existing', 'new']),
  clientId: z.string().optional(),
  clientName: opt(200),
  contactPerson: opt(200),
  clientEmail: z.string().trim().toLowerCase().max(200).optional()
    .transform((v) => v || null)
    .refine((v) => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'Client e-mail is not valid'),
  clientPhone: opt(50),
  projectName: z.string().trim().min(2, 'Enter the project name').max(300),
  siteAddress: opt(500),
  title: opt(300),
  brandId: z.coerce.number().int().positive(),
});

export async function createBoq(_prev: NewBoqState, form: FormData): Promise<NewBoqState> {
  const u = await getCurrentUser();
  if (!u || !can(u, 'boq.create')) return { error: 'You do not have permission to create BOQs.' };
  const fields = Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  const p = Schema.safeParse(fields);
  if (!p.success) return { error: firstIssue(p.error), fields };
  const d = p.data;
  if (d.clientMode === 'existing' && !z.uuid().safeParse(d.clientId).success) return { error: 'Choose a client, or add a new one.', fields };
  if (d.clientMode === 'new' && !d.clientName) return { error: 'Enter the client name.', fields };
  if (d.clientMode === 'new' && !can(u, 'crm.clients.create')) return { error: 'You cannot add clients. Pick an existing one.', fields };

  const id = await tx(u.id, async (db) => {
    let clientId = d.clientId!;
    if (d.clientMode === 'new') {
      const c = await db.query(
        `INSERT INTO clients (name, contact_person, email, phone, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [d.clientName, d.contactPerson, d.clientEmail, d.clientPhone, u.id]);
      clientId = c.rows[0].id;
    } else {
      const c = await db.query('SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL', [clientId]);
      if (!c.rowCount) throw new Error('Client not found');
    }
    const pr = await db.query(
      `INSERT INTO projects (name, site_address, client_id, status, owner_user_id, created_by)
       VALUES ($1, $2, $3, 'quoted', $4, $4) RETURNING id`,
      [d.projectName, d.siteAddress, clientId, u.id]);
    // New BOQs start from the company defaults and the latest recorded exchange rate.
    const b = await db.query(
      `INSERT INTO boqs (project_id, title, selected_brand_id, exchange_rate, imp_profit_pct, imp_discount_pct, loc_profit_pct,
                         loc_discount_pct, ait_pct, vat_pct, tax_method, offer_note, owner_user_id, created_by, updated_by)
       SELECT $1, $2, $3,
              coalesce((SELECT rate FROM exchange_rates WHERE currency_from = 'USD' AND currency_to = 'BDT'
                        ORDER BY effective_date DESC LIMIT 1), s.default_exchange_rate),
              s.default_imp_profit_pct, s.default_imp_discount_pct, s.default_loc_profit_pct, s.default_loc_discount_pct,
              s.default_ait_pct, s.default_vat_pct, s.default_tax_method, s.default_offer_note, $4, $4, $4
       FROM company_settings s WHERE s.id = 1
       RETURNING id`,
      [pr.rows[0].id, d.title, d.brandId, u.id]);
    return b.rows[0].id as string;
  });
  redirect(`/boqs/${id}`);
}
