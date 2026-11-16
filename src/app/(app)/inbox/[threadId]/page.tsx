import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReplyBox } from '@/components/inbox/ReplyBox';
import { ThreadItems } from '@/components/inbox/ThreadItems';
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

  return (
    <main className="wrap page page-narrow">
      <div className="pagehead">
        <div>
          <Link href="/inbox" className="hint">← Inbox</Link>
          <h1 style={{ fontSize: 24 }}>{thread.subject}</h1>
          <p>
            {client?.name ?? 'Unknown client'}{client?.email ? ` · ${client.email}` : ''} ·{' '}
            {thread.kind === 'boq' ? `BOQ ${thread.boq_no ?? ''}` : 'Official mail'}
          </p>
        </div>
        {thread.kind === 'boq' && thread.boq_id && <Link className="btn" href={`/boqs/${thread.boq_id}`}>Open BOQ</Link>}
      </div>

      <ThreadItems items={items} />

      <MarkRead threadId={thread.id} />

      {thread.client_id && client?.email ? (
        <ReplyBox
          threadId={thread.id} clientId={thread.client_id} to={client.email}
          subject={thread.subject} replyToInboundId={lastInbound?.id}
        />
      ) : (
        <p className="alert warn" role="status">This conversation cannot be replied to: the client has no e-mail saved.</p>
      )}
    </main>
  );
}
