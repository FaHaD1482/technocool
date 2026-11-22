import Link from 'next/link';
import { ComposeForm, type ClientOption } from '@/components/inbox/ComposeForm';
import { Icon } from '@/components/ui/Icon';
import { requirePermission } from '@/lib/auth/session';
import { getVisibleBoq } from '@/lib/boq/repo';
import { query } from '@/lib/db';
import { clientOption } from '@/lib/mail/messages';

export const metadata = { title: 'New message' };

export default async function NewMessagePage({ searchParams }: { searchParams: Promise<{ client?: string; boq?: string }> }) {
  const u = await requirePermission('mail.send');
  const sp = await searchParams;

  let client: ClientOption | null = null;
  let locked = false;
  let initial = { to: '', subject: '', body: '' };
  let note: string | null = null;

  if (sp.boq) {
    // Only a BOQ the user may see: a colleague's BOQ number/title/client is not disclosed here.
    let visible = true;
    try {
      await getVisibleBoq(u, sp.boq);
    } catch {
      visible = false;
      note = 'That BOQ was not found. Pick a client below.';
    }
    if (visible) {
      const { rows } = await query(`
        SELECT b.boq_no, b.title, p.name AS project, c.id AS client_id, c.name AS client_name, c.email AS client_email,
               (c.deleted_at IS NOT NULL) AS client_deleted
        FROM boqs b JOIN projects p ON p.id = b.project_id LEFT JOIN clients c ON c.id = p.client_id
        WHERE b.id = $1 AND b.deleted_at IS NULL`, [sp.boq]);
      const b = rows[0];
      if (!b) note = 'That BOQ was not found. Pick a client below.';
      else if (!b.client_id) note = 'That BOQ has no client attached. Pick one below.';
      else if (b.client_deleted) note = 'That client was removed from the client list. Pick another client below.';
      else {
        client = { id: b.client_id, name: b.client_name, email: b.client_email };
        locked = true;
        initial = {
          to: b.client_email ?? '',
          subject: b.title ? `${b.boq_no} — ${b.title}` : `Regarding ${b.boq_no}`,
          body: '',
        };
      }
    }
  } else if (sp.client) {
    client = await clientOption(sp.client);
    if (client) initial = { to: client.email ?? '', subject: '', body: '' };
    else note = 'That client was not found. Pick one below.';
  }

  return (
    <>
      <div className="m-top m-thread-bar">
        <Link className="m-icon" href="/inbox" aria-label="Back to Inbox" title="Back to Inbox"><Icon name="arrow-left" size={20} /></Link>
      </div>
      {note && <p className="alert warn m-pad" role="status">{note}</p>}
      <div className="m-pad">
        <ComposeForm client={client} initial={initial} lockedClient={locked} variant="page" />
      </div>
    </>
  );
}
