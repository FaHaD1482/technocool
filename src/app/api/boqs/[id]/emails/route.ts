import { NextResponse } from 'next/server';
import { apiUser, handle } from '@/lib/api';
import { getVisibleBoq } from '@/lib/boq/repo';
import { emailsForBoq } from '@/lib/mail/send';

/** Send log of one BOQ (polled by the editor while a send is in progress). */
export const GET = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const u = await apiUser('boq.view');
  const { id } = await params;
  const b = await getVisibleBoq(u, id);
  return NextResponse.json({ status: b.status, emails: await emailsForBoq(id) });
});
