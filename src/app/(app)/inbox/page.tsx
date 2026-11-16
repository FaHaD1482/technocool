import Link from 'next/link';
import { Icon } from '@/components/ui/Icon';
import { requirePermission } from '@/lib/auth/session';
import { getMailStatus } from '@/lib/mail/account';
import { threadsForUser } from '@/lib/mail/messages';
import { fmtDateTime } from '@/lib/format';

export const metadata = { title: 'Inbox' };

const FILTERS = [
  { v: 'all', label: 'All' },
  { v: 'unread', label: 'Unread' },
  { v: 'boq', label: 'BOQ' },
  { v: 'general', label: 'Official' },
] as const;
type Filter = (typeof FILTERS)[number]['v'];

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string }> }) {
  const u = await requirePermission('mail.send');
  const sp = await searchParams;
  const filter: Filter = FILTERS.some((f) => f.v === sp.filter) ? (sp.filter as Filter) : 'all';
  const q = (sp.q ?? '').trim().slice(0, 100);
  const [threads, mail] = await Promise.all([threadsForUser(u, { filter, q }), getMailStatus()]);

  /** Each filter keeps the search term, and the search box keeps the filter (hidden input below). */
  const filterHref = (v: string) => {
    const p = new URLSearchParams({ filter: v });
    if (q) p.set('q', q);
    return `/inbox?${p.toString()}`;
  };

  return (
    <main className="wrap page">
      <div className="pagehead">
        <div>
          <h1>Inbox</h1>
          <p>Conversations with clients. Replies come back to you — nobody needs the company mailbox password.</p>
        </div>
        <Link className="btn primary" href="/inbox/new"><Icon name="plus" size={16} /> New message</Link>
      </div>

      {!mail.connected && (
        <p className="alert warn" role="status">
          <span>{mail.status === 'revoked' ? 'The company Gmail is disconnected. Ask the admin to reconnect it.' : 'The company Gmail is not connected yet. Ask the admin to set it up.'} Nothing can be sent until then.</span>
        </p>
      )}

      <form className="toolbar" role="search">
        <div className="seg" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <Link key={f.v} href={filterHref(f.v)} aria-current={filter === f.v ? 'true' : undefined}>{f.label}</Link>
          ))}
        </div>
        <input type="hidden" name="filter" value={filter} />
        <label className="search"><span className="sr">Search</span>
          <input name="q" type="search" defaultValue={q} placeholder="Search client or subject" />
        </label>
      </form>

      {threads.length === 0 ? (
        <div className="card empty-state">
          <h2>{q ? `Nothing matches “${q}”` : 'No conversations yet'}</h2>
          <p>{q ? 'Try another search or filter.' : 'Write to a client, or send a BOQ — its conversation appears here too.'}</p>
          <Link className="btn primary" href="/inbox/new"><Icon name="plus" size={16} /> New message</Link>
        </div>
      ) : (
        <div className="scroller">
          <table className="list">
            <thead><tr><th>Client</th><th>Subject</th><th>Type</th><th className="n">Replies</th><th className="n">Last activity</th></tr></thead>
            <tbody>
              {threads.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link className="title" href={`/inbox/${t.id}`}>{t.clientName ?? 'Unknown client'}</Link>
                    {t.unread && <span className="badge-n hot" style={{ marginLeft: 8 }}>new</span>}
                    <span className="sub">{t.clientEmail ?? 'No e-mail'}</span>
                  </td>
                  <td>{t.subject}{t.boqNo && <span className="sub">{t.boqNo}</span>}</td>
                  <td><span className={`chip ${t.kind === 'boq' ? 'sent' : 'draft'}`}>{t.kind === 'boq' ? 'BOQ' : 'Official'}</span></td>
                  <td className="n">{t.replies}</td>
                  <td className="n">{fmtDateTime(t.lastMessageAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
