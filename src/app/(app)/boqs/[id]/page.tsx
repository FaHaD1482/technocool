import { notFound } from 'next/navigation';
import { BoqEditor } from '@/components/editor/BoqEditor';
import { MarkRead } from '@/components/ui/MarkRead';
import { ApiError } from '@/lib/api';
import { can, requirePermission } from '@/lib/auth/session';
import { loadEditorData } from '@/lib/boq/repo';
import { emailsForBoq } from '@/lib/mail/send';
import { repliesForBoq } from '@/lib/replies';

export const metadata = { title: 'BOQ' };

export default async function BoqPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await requirePermission('boq.view');
  const { id } = await params;
  try {
    const data = await loadEditorData(u, id);
    const [emails, replies] = await Promise.all([emailsForBoq(id), repliesForBoq(u, id, { markRead: false })]);
    // key: a new revision or a status change (sent / back to draft) gets a fresh editor state
    return (
      <>
        <MarkRead boqId={id} />
        <BoqEditor key={`${data.header.id}:${data.header.status}`} data={data} emails={emails} replies={replies} canMail={can(u, 'mail.send')} />
      </>
    );
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) notFound();
    throw e;
  }
}
