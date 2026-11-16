import { requirePermission } from '@/lib/auth/session';
import { assignableBoqs, unmatchedReplies } from '@/lib/replies';
import { UnmatchedList } from './UnmatchedList';

export const metadata = { title: 'Unmatched replies' };

export default async function UnmatchedPage() {
  const u = await requirePermission('mail.unmatched.manage');
  const [replies, boqs] = await Promise.all([unmatchedReplies(u), assignableBoqs()]);
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
        ? <div className="card empty-state"><h2>Nothing to sort</h2><p>Every client reply found its BOQ.</p></div>
        : <UnmatchedList replies={replies} boqs={boqs} />}
    </main>
  );
}
