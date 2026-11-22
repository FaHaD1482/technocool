import { can, requirePermission } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { NewBoqForm } from './NewBoqForm';

export const metadata = { title: 'New BOQ' };

export default async function NewBoqPage() {
  const u = await requirePermission('boq.create');
  // Only whether a client exists: the picker searches as you type instead of loading every client.
  const [anyClient, brands] = await Promise.all([
    query(`SELECT EXISTS (SELECT 1 FROM clients WHERE deleted_at IS NULL) AS any`),
    query(`SELECT id, name, full_name FROM brands WHERE is_active ORDER BY sort_order`),
  ]);
  return (
    <main className="wrap page">
      <div className="pagehead"><div><h1>New BOQ</h1><p>Three quick steps, then you build the BOQ.</p></div></div>
      <NewBoqForm
        hasClients={!!anyClient.rows[0]?.any}
        brands={brands.rows.map((b) => ({ id: b.id, name: b.name, fullName: b.full_name }))}
        canAddClient={can(u, 'crm.clients.create')}
      />
    </main>
  );
}
