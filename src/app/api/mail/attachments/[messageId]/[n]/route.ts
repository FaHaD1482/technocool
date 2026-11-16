import { NextResponse } from 'next/server';
import { apiUser, handle } from '@/lib/api';
import { attachmentFor } from '@/lib/mail/messages';

type Ctx = { params: Promise<{ messageId: string; n: string }> };

/** Private download for a general-mail attachment; always an attachment, never rendered in our origin. */
export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const u = await apiUser('mail.send');
  const { messageId, n } = await params;
  const f = await attachmentFor(u, messageId, Number(n));
  return new NextResponse(new Uint8Array(f.buf), {
    headers: {
      'Content-Type': f.mimeType,
      'Content-Disposition': `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      'Content-Security-Policy': 'sandbox; default-src \'none\'',
      'Cache-Control': 'private, no-store',
    },
  });
});
