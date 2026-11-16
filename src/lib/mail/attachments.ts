/**
 * Attachments for general client mail. Kept under $STORAGE_DIR/mail/<messageId>/<n>; the database only holds
 * the relative path, exactly like BOQ exports and inbound replies.
 *
 * Deliberately framework-free (no `server-only`, no `@/lib/api`): the background worker imports this file too.
 * Callers in the web app convert the plain Errors into ApiError.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const storageRoot = () => path.resolve(/*turbopackIgnore: true*/ process.env.STORAGE_DIR || './storage');

export const MAX_FILES = 5;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** Office files only; the extension picks the content type we send. */
const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip',
};

export const ALLOWED_LABEL = 'PDF, Word, Excel, CSV, TXT, PNG/JPG/GIF, ZIP';

export interface StoredAttachment {
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  sha256: string;
}

export interface UploadFile { buf: Buffer; fileName: string }

/** "My offer (final).xlsx" -> "My offer (final).xlsx", "..\\..\\x.exe" -> "x.exe". Never keeps a path. */
export function safeFileName(raw: string): { name: string; ext: string } {
  const base = path.basename(raw).replace(/[\\/:*?"<>|]+/g, ' ').replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  const dot = base.lastIndexOf('.');
  const stem = (dot > 0 ? base.slice(0, dot) : base).slice(0, 100).trim() || 'file';
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  return { name: `${stem}${ext ? `.${ext}` : ''}`, ext };
}

function check(file: UploadFile): { name: string; mimeType: string } {
  const { name, ext } = safeFileName(file.fileName);
  const mimeType = MIME[ext];
  if (!mimeType) throw new Error(`“${name}” cannot be attached. Allowed: ${ALLOWED_LABEL}.`);
  if (file.buf.length === 0) throw new Error(`“${name}” is empty.`);
  if (file.buf.length > MAX_FILE_BYTES) throw new Error(`“${name}” is larger than 10 MB.`);
  return { name, mimeType };
}

export async function storeAttachments(messageId: string, files: UploadFile[]): Promise<StoredAttachment[]> {
  if (!files.length) return [];
  if (files.length > MAX_FILES) throw new Error(`Attach at most ${MAX_FILES} files.`);
  const total = files.reduce((n, f) => n + f.buf.length, 0);
  if (total > MAX_TOTAL_BYTES) throw new Error('The attachments together are larger than 20 MB.');

  const dir = path.join(storageRoot(), 'mail', messageId);
  await mkdir(dir, { recursive: true });

  const out: StoredAttachment[] = [];
  for (const [i, f] of files.entries()) {
    const { name, mimeType } = check(f);
    await writeFile(path.join(dir, String(i + 1)), f.buf, { flag: 'wx' });
    out.push({
      filename: name,
      mimeType,
      size: f.buf.length,
      path: `mail/${messageId}/${i + 1}`,
      sha256: createHash('sha256').update(f.buf).digest('hex'),
    });
  }
  return out;
}

export async function readStoredAttachment(rel: string): Promise<Buffer> {
  const root = storageRoot();
  const full = path.resolve(root, rel);
  if (!full.startsWith(root + path.sep)) throw new Error('File not found.');
  return readFile(full);
}

/** Server-side re-validation just before a message leaves (the files may have been replaced on disk). */
export function validateStored(list: unknown): StoredAttachment[] {
  if (!Array.isArray(list)) return [];
  if (list.length > MAX_FILES) throw new Error('Too many attachments.');
  const out: StoredAttachment[] = [];
  let total = 0;
  for (const raw of list) {
    const a = raw as Partial<StoredAttachment>;
    const rel = typeof a.path === 'string' ? a.path : '';
    const name = typeof a.filename === 'string' ? a.filename : 'file';
    const size = typeof a.size === 'number' ? a.size : 0;
    const mimeType = MIME[safeFileName(name).ext];
    if (!/^mail\/[0-9a-f-]{36}\/\d+$/.test(rel)) throw new Error(`Bad attachment path for ${name}.`);
    if (!mimeType) throw new Error(`Refusing to send ${name}: not an allowed file type.`);
    if (size > MAX_FILE_BYTES) throw new Error(`Refusing to send ${name}: larger than 10 MB.`);
    total += size;
    out.push({ filename: name, mimeType, size, path: rel, sha256: String(a.sha256 ?? '') });
  }
  if (total > MAX_TOTAL_BYTES) throw new Error('The attachments together are larger than 20 MB.');
  return out;
}

/** Folder for one message; used to clean up when queueing fails. */
export const attachmentDir = (messageId: string) => path.join(storageRoot(), 'mail', messageId);
export const newMessageId = () => randomUUID();
