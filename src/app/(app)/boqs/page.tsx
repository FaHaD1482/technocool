import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { can, requirePermission } from '@/lib/auth/session';
import { visibleBoqs } from '@/lib/boq/repo';
import { fmt } from '@/lib/calc';
import { query } from '@/lib/db';
import { fmtDate } from '@/lib/format';
import { BOQ_STATUS, chipOf, labelOf } from '@/lib/labels';
import { replyCounts } from '@/lib/replies';

export const metadata = { title: 'BOQs' };

const FILTERS = [
  { v: 'open', label: 'Current' },
  { v: 'draft', label: 'Drafts' },
  { v: 'sent', label: 'Sent' },
  { v: 'all', label: 'All revisions' },
];

export default async function BoqList({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const u = await requirePermission('boq.view');
  const sp = await searchParams;
  const q = (sp.q ?? '').trim().slice(0, 100);
  const status = FILTERS.some((f) => f.v === sp.status) ? sp.status! : 'open';
  const all = can(u, 'boq.view_all');

  const v = visibleBoqs(u, 'b', 1);
  const params: unknown[] = [...v.params];
  const where = ['b.deleted_at IS NULL', v.sql];
  if (status === 'open') where.push(`b.status <> 'superseded'`);
  else if (status !== 'all') { params.push(status); where.push(`b.status = $${params.length}`); }
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
    const i = params.length;
    where.push(`(b.boq_no ILIKE $${i} OR p.name ILIKE $${i} OR c.name ILIKE $${i} OR b.title ILIKE $${i})`);
  }
  const { rows } = await query(
    `SELECT b.id, b.boq_no, b.revision, b.status, b.title, b.grand_total_bdt, b.updated_at, b.sent_at,
            p.name AS project_name, c.name AS client_name, br.name AS brand, u.full_name AS owner_name
     FROM boqs b
     JOIN projects p ON p.id = b.project_id
     LEFT JOIN clients c ON c.id = p.client_id
     JOIN brands br ON br.id = b.selected_brand_id
     LEFT JOIN app_users u ON u.id = b.owner_user_id
     WHERE ${where.join(' AND ')}
     ORDER BY b.updated_at DESC
     LIMIT 300`, params);

  const counts = await replyCounts(u, rows.map((r) => r.id));

  /** Each filter keeps the search term, and the search box keeps the filter (hidden input below). */
  const filterHref = (v: string) => {
    const p = new URLSearchParams({ status: v });
    if (q) p.set('q', q);
    return `/boqs?${p.toString()}`;
  };

  return (
    <main className="wrap page">
      <div className="pagehead">
        <div>
          <h1>{all ? 'All BOQs' : 'My BOQs'}</h1>
          <p>{all ? 'Every BOQ in the company.' : 'Only the BOQs you own. Replies from your clients show inside each BOQ.'}</p>
        </div>
        {can(u, 'boq.create') && <Link className="btn primary" href="/boqs/new"><Icon name="plus" size={16} /> New BOQ</Link>}
      </div>

      <form className="toolbar" role="search">
        <div className="seg" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <Link key={f.v} href={filterHref(f.v)} aria-current={status === f.v ? 'true' : undefined}>{f.label}</Link>
          ))}
        </div>
        <input type="hidden" name="status" value={status} />
        <label className="search"><span className="sr">Search</span>
          <input name="q" type="search" defaultValue={q} placeholder="Search BOQ no., project or client" />
        </label>
      </form>

      {rows.length === 0 ? (
        <div className="card empty-state">
          <h2>{q ? `Nothing matches “${q}”` : 'No BOQs yet'}</h2>
          <p>{q ? 'Try another search or filter.' : 'Create your first BOQ: pick a client and project, then add equipment and local items.'}</p>
          {!q && can(u, 'boq.create') && <Link className="btn primary" href="/boqs/new"><Icon name="plus" size={16} /> New BOQ</Link>}
        </div>
      ) : (
        <div className="scroller">
          <table className="list">
            <thead><tr>
              <th>BOQ</th><th>Project · client</th><th>Brand</th><th>Status</th><th className="n">Replies</th>
              {all && <th>Owner</th>}
              <th className="n">Grand total Tk</th><th className="n">Updated</th>
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Link className="title mono" href={`/boqs/${r.id}`}>{r.boq_no} R{r.revision}</Link>{r.title && <span className="sub">{r.title}</span>}</td>
                  <td>{r.project_name}<span className="sub">{r.client_name ?? 'No client'}</span></td>
                  <td>{r.brand}</td>
                  <td><span className={`chip ${chipOf(BOQ_STATUS, r.status)}`}>{labelOf(BOQ_STATUS, r.status)}</span></td>
                  <td className="n">{(() => { const c = counts.get(r.id); return c ? <span className={`badge-n${c.unread ? ' hot' : ''}`} title={c.unread ? `${c.unread} new` : undefined}>{c.total}</span> : ''; })()}</td>
                  {all && <td>{r.owner_name ?? '—'}</td>}
                  <td className="n">{r.grand_total_bdt === null ? '—' : fmt(r.grand_total_bdt)}</td>
                  <td className="n">{fmtDate(r.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
