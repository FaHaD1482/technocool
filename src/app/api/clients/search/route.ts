import { NextResponse } from 'next/server';
import { ApiError, apiUser, handle } from '@/lib/api';
import { clientOption, searchClients } from '@/lib/mail/messages';

/**
 * Type-ahead for client pickers (Compose, New BOQ): at most 20 matches per request, or `?id=` for one client.
 * Allowed for anyone who may pick a client somewhere: write mail, create a BOQ or view clients.
 */
export const GET = handle(async (req: Request) => {
  const u = await apiUser();
  if (!['mail.send', 'boq.create', 'crm.clients.view'].some((p) => u.permissions.has(p as never))) {
    throw new ApiError(403, 'You do not have permission to do that.');
  }
  const sp = new URL(req.url).searchParams;
  const id = sp.get('id');
  const rows = id ? [await clientOption(id)].filter(Boolean) : await searchClients(sp.get('q') ?? '', 20);
  return NextResponse.json(rows, { headers: { 'Cache-Control': 'no-store' } });
});
