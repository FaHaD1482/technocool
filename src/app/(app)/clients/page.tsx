import Link from 'next/link';
import { Pager } from '@/components/ui/Pager';
import { can, requirePermission } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { likePattern, parsePage } from '@/lib/paging';
import { AddClientForm } from './AddClientForm';
import { ClientsClient } from './ClientsClient';

export const metadata = { title: 'Clients' };

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const u = await requirePermission('crm.clients.view');
  const sp = await searchParams;
  const q = (sp.q ?? '').trim().slice(0, 100);
  const pg = parsePage(sp.page);

  const params: unknown[] = [];
  let where = 'c.deleted_at IS NULL';
  if (q) {
    params.push(likePattern(q));
    where += ` AND (c.name ILIKE $1 OR c.email ILIKE $1 OR c.contact_person ILIKE $1 OR c.phone ILIKE $1)`;
  }
  const [{ rows }, countRes] = await Promise.all([
    query(`
      SELECT c.id, c.name, c.contact_person, c.email, c.phone, c.address,
             (SELECT count(*) FROM projects p WHERE p.client_id = c.id AND p.deleted_at IS NULL) AS projects
      FROM clients c WHERE ${where}
      ORDER BY lower(c.name), c.id LIMIT ${pg.size} OFFSET ${pg.offset}`, params),
    query(`SELECT count(*)::int AS n FROM clients c WHERE ${where}`, params),
  ]);
  const total: number = countRes.rows[0]?.n ?? 0;

  return (
    <main className="wrap page">
      <div className="pagehead"><div><h1>Clients</h1><p>Who BOQs are sent to. The e-mail here is where Send will deliver.</p></div></div>
      <form className="toolbar" role="search">
        <label className="search"><span className="sr">Search clients</span>
          <input name="q" type="search" defaultValue={q} placeholder="Search name, e-mail, contact or phone" />
        </label>
        {q && <Link className="btn small ghost" href="/clients">Clear</Link>}
      </form>
      <div className="grid-2">
        <div className="stack" style={{ gap: 12, minWidth: 0 }}>
          <ClientsClient rows={rows} canManage={can(u, 'crm.clients.manage')}
            emptyText={q ? `No client matches “${q}”.` : total > 0 ? 'That page is empty.' : 'No clients yet.'} />
          <Pager path="/clients" params={{ q: q || undefined }} page={pg.page} size={pg.size} total={total} />
        </div>
        {can(u, 'crm.clients.create') && <AddClientForm />}
      </div>
    </main>
  );
}
