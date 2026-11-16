import { apiUser, handle } from '@/lib/api';
import { readExport } from '@/lib/excel/export';

export const GET = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const u = await apiUser('boq.view');
  const { id } = await params;
  const { buf, fileName } = await readExport(u, id);
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      'Cache-Control': 'private, no-store',
    },
  });
});
