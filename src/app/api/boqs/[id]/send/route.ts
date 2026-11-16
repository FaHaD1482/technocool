import { NextResponse } from 'next/server';
import { ApiError, apiUser, handle } from '@/lib/api';
import { MAX_UPLOAD_MB, queueSend, SendSchema, sendPreflight } from '@/lib/mail/send';

type Ctx = { params: Promise<{ id: string }> };

/** What the Send dialog needs: defaults, blockers (0 rates, Gmail not connected, limit), daily counter. */
export const GET = handle(async (_req: Request, { params }: Ctx) => {
  const u = await apiUser('boq.view');
  const { id } = await params;
  return NextResponse.json(await sendPreflight(u, id));
});

/**
 * Queue the e-mail; the worker sends it.
 * JSON body = the files the app builds. multipart/form-data = the workbook the estimator edited in Excel.
 */
export const POST = handle(async (req: Request, { params }: Ctx) => {
  const u = await apiUser('boq.send');
  const { id } = await params;

  if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File) || !file.size) throw new ApiError(400, 'Choose the Excel file you edited.');
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      throw new ApiError(400, `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. Keep it under ${MAX_UPLOAD_MB} MB.`);
    }
    const input = SendSchema.parse({
      to: form.get('to'), cc: form.get('cc') ?? '', subject: form.get('subject'),
      body: form.get('body'), currency: form.get('currency') ?? 'BDT', attachment: 'upload',
    });
    return NextResponse.json(await queueSend(u, id, input, { buf: Buffer.from(await file.arrayBuffer()), fileName: file.name }));
  }

  return NextResponse.json(await queueSend(u, id, SendSchema.parse(await req.json())));
});
