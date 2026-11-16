import { NextResponse } from 'next/server';
import { apiUser, handle } from '@/lib/api';
import { markThreadRead, timelineForThread } from '@/lib/mail/messages';

type Ctx = { params: Promise<{ id: string }> };

/** One conversation, oldest message first. Read-only: opening a thread does not clear notifications (that is a POST). */
export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const u = await apiUser('mail.send');
  const { id } = await params;
  return NextResponse.json(await timelineForThread(u, id));
});

/** Clears this conversation's notifications for the caller. */
export const POST = handle(async (_req: Request, { params }: Ctx) => {
  const u = await apiUser('mail.send');
  const { id } = await params;
  await markThreadRead(u, id);
  return NextResponse.json({ ok: true });
});
