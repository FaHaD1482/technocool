import { NextResponse } from 'next/server';
import { apiUser, handle } from '@/lib/api';
import { unreadCount } from '@/lib/replies';

/** Unread count for the bell (polled every minute). */
export const GET = handle(async () => {
  const u = await apiUser();
  return NextResponse.json({ unread: await unreadCount(u.id) }, { headers: { 'Cache-Control': 'no-store' } });
});