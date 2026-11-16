import { apiUser, handle } from '@/lib/api';
import { readReplyFile } from '@/lib/replies';

/** A client's reply attachment, after the own-BOQ check. Always downloaded, never rendered in the app's origin. */
export const GET = handle(async (_req: Request, { params }: { params: Promise<{ id: string; n: string }> }) => {
  const u = await apiUser('boq.view');
  const { id, n } = await params;
  const f = await readReplyFile(u, id, Number(n));
  return new Response(new Uint8Array(f.buf), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Cache-Control': 'private, no-store',
    },
  });
});
