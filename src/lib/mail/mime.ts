/**
 * Builds an RFC 5322 message (text + HTML + attachments) for Gmail's messages.send.
 * Header values are checked for line breaks (header-injection guard) and non-ASCII text is RFC 2047 encoded.
 */
import { randomBytes } from 'node:crypto';

export interface Attachment { filename: string; contentType: string; content: Buffer }
export interface MimeInput {
  from: { name: string | null; address: string };
  to: string[];
  cc: string[];
  replyTo: string;
  subject: string;
  text: string;
  html: string;
  messageId: string;
  date?: Date;
  headers?: Record<string, string>;
  attachments: Attachment[];
}

const CRLF = '\r\n';

function safeHeader(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error('Line break in an e-mail header.');
  return v;
}

/** =?UTF-8?B?...?= in chunks small enough for a 76-character line. */
export function encodeWord(v: string): string {
  safeHeader(v);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const out: string[] = [];
  let chunk = '';
  for (const ch of v) {
    if (Buffer.byteLength(chunk + ch) > 45) { out.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) out.push(chunk);
  return out.map((c) => `=?UTF-8?B?${Buffer.from(c).toString('base64')}?=`).join(`${CRLF} `);
}

export function formatAddress(name: string | null, address: string): string {
  safeHeader(address);
  if (!/^[^@\s<>",]+@[^@\s<>",]+$/.test(address)) throw new Error(`Not a valid address: ${address}`);
  if (!name) return address;
  const n = /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodeWord(name);
  return `${n} <${address}>`;
}

const b64lines = (buf: Buffer) => buf.toString('base64').replace(/.{76}(?=.)/g, `$&${CRLF}`);

function filenameParams(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function buildMime(m: MimeInput): Buffer {
  const mixed = `mixed_${randomBytes(12).toString('hex')}`;
  const alt = `alt_${randomBytes(12).toString('hex')}`;
  const head: string[] = [
    `From: ${formatAddress(m.from.name, m.from.address)}`,
    `To: ${m.to.map((a) => formatAddress(null, a)).join(', ')}`,
    ...(m.cc.length ? [`Cc: ${m.cc.map((a) => formatAddress(null, a)).join(', ')}`] : []),
    `Reply-To: ${formatAddress(null, m.replyTo)}`,
    `Subject: ${encodeWord(m.subject)}`,
    `Message-ID: ${safeHeader(m.messageId)}`,
    `Date: ${(m.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    'MIME-Version: 1.0',
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${safeHeader(k)}: ${encodeWord(v)}`),
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
  ];
  const parts: string[] = [
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`, '',
    `--${alt}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(m.text)),
    `--${alt}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(m.html)),
    `--${alt}--`,
  ];
  for (const a of m.attachments) {
    parts.push(
      `--${mixed}`,
      `Content-Type: ${safeHeader(a.contentType)}; name="${a.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')}"`,
      `Content-Disposition: attachment; ${filenameParams(a.filename)}`,
      'Content-Transfer-Encoding: base64', '', b64lines(a.content),
    );
  }
  parts.push(`--${mixed}--`, '');
  return Buffer.from(head.join(CRLF) + CRLF + CRLF + parts.join(CRLF));
}

/** Plain text -> minimal safe HTML (escaped, line breaks kept). */
export function textToHtml(text: string): string {
  const esc = text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#14212a">${esc.replace(/\r?\n/g, '<br>')}</body></html>`;
}
