import { NextResponse } from 'next/server';
import { apiUser, handle } from '@/lib/api';
import { countThreadsForUser, threadsForUser } from '@/lib/mail/messages';
import { parsePage } from '@/lib/paging';

/**
 * Conversations for the Inbox list (own conversations, or everyone's with mail.view_all).
 * Paged with `?page=` (50 per page); the total is in the `X-Total-Count` header so the body stays an array.
 */
export const GET = handle(async (req: Request) => {
  const u = await apiUser('mail.send');
  const url = new URL(req.url);
  const f = url.searchParams.get('filter') ?? 'all';
  const filter = (['all', 'unread', 'boq', 'general'] as const).includes(f as never) ? (f as 'all' | 'unread' | 'boq' | 'general') : 'all';
  const q = url.searchParams.get('q') ?? undefined;
  const pg = parsePage(url.searchParams.get('page') ?? undefined);
  const [rows, total] = await Promise.all([
    threadsForUser(u, { filter, q, take: pg.size, offset: pg.offset }),
    countThreadsForUser(u, { filter, q }),
  ]);
  return NextResponse.json(rows, { headers: { 'X-Total-Count': String(total) } });
});
