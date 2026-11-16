import { can, requirePermission } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { NewBoqForm } from './NewBoqForm';

export const metadata = { title: 'New BOQ' };

export default async function NewBoqPage() {
  const u = await requirePermission('boq.create');
  const [clients, brands] = await Promise.all([
    query(`SELECT id, name, email FROM clients WHERE deleted_at IS NULL ORDER BY lower(name)`),
    query(`SELECT id, name, full_name FROM brands WHERE is_active ORDER BY sort_order`),
  ]);
  return (
    <main className="wrap page">
      <div className="pagehead"><div><h1>New BOQ</h1><p>Three quick steps, then you build the BOQ.</p></div></div>
      <NewBoqForm
        clients={clients.rows}
        brands={brands.rows.map((b) => ({ id: b.id, name: b.name, fullName: b.full_name }))}
        canAddClient={can(u, 'crm.clients.create')}
      />
    </main>
  );
}
