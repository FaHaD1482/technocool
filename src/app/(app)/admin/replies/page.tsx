import { Pager } from '@/components/ui/Pager';
import { requirePermission } from '@/lib/auth/session';
import { parsePage } from '@/lib/paging';
import { assignableBoqs, countUnmatchedReplies, unmatchedReplies } from '@/lib/replies';
import { UnmatchedList } from './UnmatchedList';

export const metadata = { title: 'Unmatched replies' };

const SIZE = 25;

export default async function UnmatchedPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const u = await requirePermission('mail.unmatched.manage');
  const pg = parsePage((await searchParams).page, SIZE);
  const [replies, total, boqs] = await Promise.all([
    unmatchedReplies(u, pg.size, pg.offset), countUnmatchedReplies(u), assignableBoqs(),
  ]);
  return (
    <main className="wrap page page-narrow">
      <div className="pagehead">
        <div>
          <h1>Unmatched replies</h1>
          <p>Mail from a known client (or with a BOQ code) that no rule could link to a sent BOQ. Assign it and the owner is notified.
            Other inbox mail is never stored. Only admins see this page.</p>
        </div>
      </div>
      {replies.length === 0
        ? (total > 0
          ? <div className="card empty-state"><h2>That page is empty</h2><p>{total} replies are waiting on earlier pages.</p></div>
          : <div className="card empty-state"><h2>Nothing to sort</h2><p>Every client reply found its BOQ.</p></div>)
        : <UnmatchedList replies={replies} boqs={boqs} />}
      <Pager path="/admin/replies" params={{}} page={pg.page} size={pg.size} total={total} />
    </main>
  );
}
