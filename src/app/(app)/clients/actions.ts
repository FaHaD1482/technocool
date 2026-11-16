'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { can, getCurrentUser } from '@/lib/auth/session';
import { tx } from '@/lib/db';
import { firstIssue } from '@/lib/forms';

export type ClientState = { error?: string; ok?: string };

const opt = (max: number) => z.string().trim().max(max).optional().transform((v) => v || null);
const Schema = z.object({
  name: z.string().trim().min(2, 'Enter the client name').max(200),
  contactPerson: opt(200),
  email: z.string().trim().toLowerCase().max(200).optional().transform((v) => v || null)
    .refine((v) => !v || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v), 'E-mail is not valid'),
  phone: opt(50),
  address: opt(500),
});

export async function addClient(_prev: ClientState, form: FormData): Promise<ClientState> {
  const u = await getCurrentUser();
  if (!u || !can(u, 'crm.clients.create')) return { error: 'You do not have permission to add clients.' };
  const p = Schema.safeParse(Object.fromEntries(form.entries()));
  if (!p.success) return { error: firstIssue(p.error) };
  const d = p.data;
  await tx(u.id, (db) => db.query(
    `INSERT INTO clients (name, contact_person, email, phone, address, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [d.name, d.contactPerson, d.email, d.phone, d.address, u.id]));
  revalidatePath('/clients');
  return { ok: `Added ${d.name}.` };
}

const IdSchema = z.string().uuid();

export async function updateClient(_prev: ClientState, form: FormData): Promise<ClientState> {
  const u = await getCurrentUser();
  if (!u || !can(u, 'crm.clients.manage')) return { error: 'You do not have permission to change clients.' };
  const id = IdSchema.safeParse(form.get('id'));
  if (!id.success) return { error: 'Pick a client first.' };
  const p = Schema.safeParse(Object.fromEntries(form.entries()));
  if (!p.success) return { error: firstIssue(p.error) };
  const d = p.data;
  const { rowCount } = await tx(u.id, (db) => db.query(
    `UPDATE clients SET name = $2, contact_person = $3, email = $4, phone = $5, address = $6
     WHERE id = $1 AND deleted_at IS NULL`,
    [id.data, d.name, d.contactPerson, d.email, d.phone, d.address]));
  if (!rowCount) return { error: 'That client no longer exists.' };
  revalidatePath('/clients');
  revalidatePath('/boqs/new');
  return { ok: `Saved ${d.name}.` };
}

/** Soft delete: the row is kept so existing projects, BOQs and sent mail still resolve. */
export async function deleteClient(id: string): Promise<ClientState> {
  const u = await getCurrentUser();
  if (!u || !can(u, 'crm.clients.manage')) return { error: 'You do not have permission to remove clients.' };
  const parsed = IdSchema.safeParse(id);
  if (!parsed.success) return { error: 'Pick a client first.' };
  const { rowCount } = await tx(u.id, (db) => db.query(
    `UPDATE clients SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [parsed.data]));
  if (!rowCount) return { error: 'That client was already removed.' };
  revalidatePath('/clients');
  revalidatePath('/boqs/new');
  return { ok: 'Client removed.' };
}
