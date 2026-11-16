import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiUser, handle } from '@/lib/api';
import { createExports } from '@/lib/excel/export';

const Body = z.object({ currency: z.enum(['BDT', 'USD', 'BOTH']), withCosting: z.boolean().default(false) });

/** Builds the Excel file(s) from the saved BOQ; the client then downloads each from /api/exports/:id. */
export const POST = handle(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const u = await apiUser('boq.export');
  const { id } = await params;
  const { currency, withCosting } = Body.parse(await req.json());
  return NextResponse.json(await createExports(u, id, currency, { withCosting }));
});
