import { NextResponse } from 'next/server';
import { ApiError, apiUser, handle } from '@/lib/api';
import { MAX_FILES } from '@/lib/mail/attachments';
import { ComposeSchema, queueMessage } from '@/lib/mail/messages';

/** Queue a general/official message, or a reply inside an existing conversation. JSON or multipart with files. */
export const POST = handle(async (req: Request) => {
  const u = await apiUser('mail.send');

  if ((req.headers.get('content-type') ?? '').startsWith('multipart/form-data')) {
    const form = await req.formData();
    const str = (v: FormDataEntryValue | null) => (typeof v === 'string' && v ? v : undefined);
    const files = [...form.getAll('files')].filter((f): f is File => f instanceof File && f.size > 0);
    if (files.length > MAX_FILES) throw new ApiError(400, `Attach at most ${MAX_FILES} files.`);

    const input = ComposeSchema.parse({
      clientId: str(form.get('clientId')), to: str(form.get('to')) ?? '', cc: str(form.get('cc')) ?? '',
      subject: str(form.get('subject')), body: str(form.get('body')),
      threadId: str(form.get('threadId')), replyToInboundId: str(form.get('replyToInboundId')),
    });
    const uploads = await Promise.all(files.map(async (f) => ({ buf: Buffer.from(await f.arrayBuffer()), fileName: f.name })));
    return NextResponse.json(await queueMessage(u, input, uploads));
  }

  return NextResponse.json(await queueMessage(u, ComposeSchema.parse(await req.json())));
});
