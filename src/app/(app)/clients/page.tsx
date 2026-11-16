import { can, requirePermission } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { AddClientForm } from './AddClientForm';
import { ClientsClient } from './ClientsClient';

export const metadata = { title: 'Clients' };

export default async function ClientsPage() {
  const u = await requirePermission('crm.clients.view');
  const { rows } = await query(`
    SELECT c.id, c.name, c.contact_person, c.email, c.phone, c.address,
           (SELECT count(*) FROM projects p WHERE p.client_id = c.id AND p.deleted_at IS NULL) AS projects
    FROM clients c WHERE c.deleted_at IS NULL ORDER BY lower(c.name)`);
  return (
    <main className="wrap page">
      <div className="pagehead"><div><h1>Clients</h1><p>Who BOQs are sent to. The e-mail here is where Send will deliver.</p></div></div>
      <div className="grid-2">
        <ClientsClient rows={rows} canManage={can(u, 'crm.clients.manage')} />
        {can(u, 'crm.clients.create') && <AddClientForm />}
      </div>
    </main>
  );
}
