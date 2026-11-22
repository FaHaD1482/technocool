import Link from 'next/link';
import { Avatar } from '@/components/inbox/Avatar';
import { ComposeButton } from '@/components/inbox/MailShell';
import { Icon } from '@/components/ui/Icon';
import { requirePermission } from '@/lib/auth/session';
import { Pager } from '@/components/ui/Pager';
import { countThreadsForUser, threadsForUser } from '@/lib/mail/messages';
import { parsePage } from '@/lib/paging';
import { fmtMailDate, fmtMailFull } from '@/lib/format';

export const metadata = { title: 'Inbox' };

const FILTERS = ['all', 'unread', 'boq', 'general'] as const;
type Filter = (typeof FILTERS)[number];
const TITLES: Record<Filter, string> = { all: 'Inbox', unread: 'Unread', boq: 'BOQ mail', general: 'Official mail' };

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ filter?: string; q?: string; page?: string }> }) {
  const u = await requirePermission('mail.send');
  const sp = await searchParams;
  const filter: Filter = (FILTERS as readonly string[]).includes(sp.filter ?? '') ? (sp.filter as Filter) : 'all';
  const q = (sp.q ?? '').trim().slice(0, 100);
  const pg = parsePage(sp.page);
  const [threads, total] = await Promise.all([
    threadsForUser(u, { filter, q, take: pg.size, offset: pg.offset }),
    countThreadsForUser(u, { filter, q }),
  ]);
  const now = new Date();
  const pagerParams = { filter: filter === 'all' ? undefined : filter, q: q || undefined };

  return (
    <>
      <div className="m-top">
        <form className="m-search" role="search">
          {filter !== 'all' && <input type="hidden" name="filter" value={filter} />}
          <Icon name="search" size={20} />
          <label className="sr" htmlFor="m-q">Search mail</label>
          <input id="m-q" name="q" type="search" defaultValue={q} placeholder="Search mail by client, e-mail or subject" />
          {q && <Link className="m-icon" href={filter === 'all' ? '/inbox' : `/inbox?filter=${filter}`} aria-label="Clear search" title="Clear search"><Icon name="close" size={18} /></Link>}
        </form>
      </div>

      <div className="m-list-head">
        <h1>{q ? `Results for “${q}”` : TITLES[filter]}</h1>
        <span className="m-range">
          {total > 0 && <Pager compact path="/inbox" params={pagerParams} page={pg.page} size={pg.size} total={total} />}
        </span>
      </div>

      {threads.length === 0 && total > 0 ? (
        <div className="m-empty">
          <h2>That page is empty</h2>
          <Link className="btn" href={filter === 'all' ? '/inbox' : `/inbox?filter=${filter}`}>Back to the newest mail</Link>
        </div>
      ) : threads.length === 0 ? (
        <div className="m-empty">
          <Icon name="inbox" size={48} />
          <h2>{q ? `No mail matches “${q}”` : filter === 'unread' ? 'You’re all caught up' : 'No conversations here yet'}</h2>
          <p>{q ? 'Try another word, or search in Inbox.' : 'Write to a client, or send a BOQ: its conversation appears here.'}</p>
          <ComposeButton className="btn primary"><Icon name="pencil" size={16} /> Compose</ComposeButton>
        </div>
      ) : (
        <ul className="m-list">
          {threads.map((t) => {
            const who = t.clientName ?? t.clientEmail ?? 'Unknown client';
            return (
              <li key={t.id}>
                <Link href={`/inbox/${t.id}`} className={`m-row${t.unread ? ' unread' : ''}`}>
                  <span className="m-row-avatar"><Avatar name={who} size={36} /></span>
                  <span className="m-from">
                    {who}{t.messages > 1 && <small className="m-n"> {t.messages}</small>}
                  </span>
                  <span className="m-text">
                    <span className={`m-label ${t.kind}`}>{t.kind === 'boq' ? (t.boqNo ?? 'BOQ') : 'Official'}</span>
                    <span className="m-subj">{t.subject}</span>
                    {t.snippet && <span className="m-snip"><span className="m-dash"> – </span>{t.snippet}</span>}
                  </span>
                  <span className="m-clip" title={t.hasFiles ? 'Has attachments' : undefined}>
                    {t.hasFiles && <Icon name="paperclip" size={16} />}
                  </span>
                  <time className="m-date" dateTime={t.lastMessageAt} title={fmtMailFull(t.lastMessageAt)}>
                    {fmtMailDate(t.lastMessageAt, now)}
                  </time>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {threads.length > 0 && total > pg.size && (
        <div className="m-foot"><Pager compact path="/inbox" params={pagerParams} page={pg.page} size={pg.size} total={total} /></div>
      )}
    </>
  );
}
