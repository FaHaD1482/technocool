import { NextResponse } from 'next/server';
import { apiUser, handle } from '@/lib/api';
import { threadsForUser } from '@/lib/mail/messages';

/** Conversations for the Inbox list (own conversations, or everyone's with mail.view_all). */
export const GET = handle(async (req: Request) => {
  const u = await apiUser('mail.send');
  const url = new URL(req.url);
  const f = url.searchParams.get('filter') ?? 'all';
  const filter = (['all', 'unread', 'boq', 'general'] as const).includes(f as never) ? (f as 'all' | 'unread' | 'boq' | 'general') : 'all';
  return NextResponse.json(await threadsForUser(u, { filter, q: url.searchParams.get('q') ?? undefined }));
});
