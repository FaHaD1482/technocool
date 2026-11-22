import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReplyBox } from '@/components/inbox/ReplyBox';
import { ThreadItems } from '@/components/inbox/ThreadItems';
import { Icon } from '@/components/ui/Icon';
import { MarkRead } from '@/components/ui/MarkRead';
import { ApiError } from '@/lib/api';
import { requirePermission } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { timelineForThread } from '@/lib/mail/messages';

export const metadata = { title: 'Conversation' };

export default async function ThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const u = await requirePermission('mail.send');
  const { threadId } = await params;

  let data;
  try {
    data = await timelineForThread(u, threadId);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) notFound();
    throw e;
  }
  const { thread, items } = data;
  // The read-mark is a POST from the client (rendering must not write).

  const { rows } = await query(`SELECT name, email FROM clients WHERE id = $1`, [thread.client_id]);
  const client = rows[0] as { name: string; email: string | null } | undefined;
  const lastInbound = [...items].reverse().find((i) => i.direction === 'in');
  const clientName = client?.name ?? 'Unknown client';

  return (
    <>
      <div className="m-top m-thread-bar">
        <Link className="m-icon" href="/inbox" aria-label="Back to Inbox" title="Back to Inbox"><Icon name="arrow-left" size={20} /></Link>
        {thread.kind === 'boq' && thread.boq_id && (
          <Link className="btn small" href={`/boqs/${thread.boq_id}`}><Icon name="boq" size={15} /> Open BOQ</Link>
        )}
      </div>

      <div className="m-subject">
        <h1>{thread.subject}</h1>
        <span className={`m-label ${thread.kind}`}>{thread.kind === 'boq' ? (thread.boq_no ?? 'BOQ') : 'Official'}</span>
        <span className="m-label plain">{clientName}</span>
      </div>

      <ThreadItems items={items} clientName={clientName} clientEmail={client?.email ?? null} />

      <MarkRead threadId={thread.id} refresh />

      {thread.client_id && client?.email ? (
        <ReplyBox
          threadId={thread.id} clientId={thread.client_id} to={client.email} me={u.fullName}
          subject={thread.subject} replyToInboundId={lastInbound?.id}
        />
      ) : (
        <p className="alert warn m-pad" role="status">This conversation cannot be replied to: the client has no e-mail saved.</p>
      )}
    </>
  );
}
