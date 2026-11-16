import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiUser, handle } from '@/lib/api';
import { getVisibleBoq } from '@/lib/boq/repo';
import { query } from '@/lib/db';
import { getVisibleThread } from '@/lib/mail/threads';

const Body = z.union([
  z.object({ threadId: z.string().uuid() }),
  z.object({ boqId: z.string().uuid() }),
]);

/** Marks a conversation's (or a BOQ's) reply notifications read. Kept off GET so rendering never writes. */
export const POST = handle(async (req: Request) => {
  const u = await apiUser();
  const body = Body.parse(await req.json());

  if ('threadId' in body) {
    await getVisibleThread(u, body.threadId);
    await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND thread_id = $2 AND read_at IS NULL`,
      [u.id, body.threadId]);
  } else {
    await getVisibleBoq(u, body.boqId);
    await query(
      `UPDATE notifications SET read_at = now()
       WHERE user_id = $1 AND read_at IS NULL
         AND (boq_id = $2 OR inbound_message_id IN (SELECT id FROM inbound_messages WHERE boq_id = $2))`,
      [u.id, body.boqId]);
  }
  return NextResponse.json({ ok: true });
});
