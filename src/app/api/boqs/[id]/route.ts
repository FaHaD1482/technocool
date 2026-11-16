import { NextResponse } from 'next/server';
import { apiUser, handle } from '@/lib/api';
import { loadEditorData, SaveSchema, saveBoq } from '@/lib/boq/repo';

type Ctx = { params: Promise<{ id: string }> };

export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const u = await apiUser('boq.view');
  const { id } = await params;
  return NextResponse.json(await loadEditorData(u, id));
});

/** Autosave from the editor: settings + every line that should be stored. */
export const PUT = handle(async (req: Request, { params }: Ctx) => {
  const u = await apiUser('boq.view');
  const { id } = await params;
  const body = SaveSchema.parse(await req.json());
  return NextResponse.json(await saveBoq(u, id, body));
});
