import { timingSafeEqual } from 'node:crypto';
import { query } from '@/lib/db';

/**
 * Gmail push (Google Pub/Sub, optional). Pub/Sub cannot sign in, so it proves itself with a secret token in the
 * push URL: <APP_URL>/api/integrations/gmail/push?token=<GMAIL_PUSH_TOKEN>. The body is ignored: we only wake the
 * worker, which then reads the Gmail history itself (so a forged push can do nothing but trigger a normal check).
 */
export async function POST(req: Request) {
  const expected = process.env.GMAIL_PUSH_TOKEN ?? '';
  const got = new URL(req.url).searchParams.get('token') ?? '';
  if (expected.length < 24 || got.length !== expected.length || !timingSafeEqual(Buffer.from(got), Buffer.from(expected))) {
    return new Response(null, { status: 403 });
  }
  await query(`SELECT pg_notify('boq_mail_in', 'push')`);
  return new Response(null, { status: 204 });   // 2xx = acknowledged, Pub/Sub will not retry
}
