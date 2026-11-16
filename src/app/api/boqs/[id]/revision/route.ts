import { NextResponse } from 'next/server';
import { apiUser, handle } from '@/lib/api';
import { createRevision } from '@/lib/boq/repo';

export const POST = handle(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const u = await apiUser('boq.create');
  const { id } = await params;
  return NextResponse.json({ id: await createRevision(u, id) });
});
