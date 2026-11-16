/** Pure helpers to read a Gmail API message: headers, text body, attachments. */
import type { GmailMessage, GmailPart } from './gmail';

/** Headers fetched in the first, headers-only pass (no body is downloaded for mail that does not match). */
export const MATCH_HEADERS = ['From', 'To', 'Cc', 'Delivered-To', 'Subject', 'Message-ID', 'In-Reply-To', 'References', 'Date',
  'Auto-Submitted', 'Precedence', 'X-Autoreply', 'X-Autorespond', 'X-Auto-Response-Suppress', 'Authentication-Results'];

export function headerMap(m: GmailMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of m.payload?.headers ?? []) {
    const k = h.name.toLowerCase();
    out[k] = out[k] ? `${out[k]}, ${h.value}` : h.value;   // Delivered-To can repeat
  }
  return out;
}

/** "A <a@x.com>, b@y.com" -> ["a@x.com", "b@y.com"] (quoted display names with commas are handled). */
export function addressList(v: string | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  for (const m of v.matchAll(/<([^<>\s]+@[^<>\s]+)>|([^\s,;<>"]+@[^\s,;<>"]+)/g)) {
    const addr = m[1] ?? m[2];
    if (addr) out.push(addr.toLowerCase());
  }
  return [...new Set(out)];
}

export function displayName(v: string | undefined): string | null {
  const m = v?.match(/^\s*"?([^"<]*?)"?\s*</);
  return m?.[1]?.trim() || null;
}

const decode = (data?: string) => (data ? Buffer.from(data, 'base64url').toString('utf8') : '');

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export interface ParsedBody {
  text: string;
  html: string | null;
  attachments: { filename: string; mimeType: string; size: number; attachmentId: string }[];
}

export function parseBody(m: GmailMessage): ParsedBody {
  let text = '', html = '';
  const attachments: ParsedBody['attachments'] = [];
  const walk = (p: GmailPart | undefined) => {
    if (!p) return;
    const type = (p.mimeType ?? '').toLowerCase();
    if (p.filename && p.body?.attachmentId) {
      attachments.push({ filename: p.filename.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 200), mimeType: type || 'application/octet-stream', size: p.body.size ?? 0, attachmentId: p.body.attachmentId });
    } else if (type === 'text/plain' && !text) text = decode(p.body?.data);
    else if (type === 'text/html' && !html) html = decode(p.body?.data);
    p.parts?.forEach(walk);
  };
  walk(m.payload);
  return { text: (text || htmlToText(html)).replace(/\r\n/g, '\n').slice(0, 200_000), html: html ? html.slice(0, 500_000) : null, attachments };
}

/** Split a reply into what the client wrote and the quoted earlier mail (for a "show quoted" toggle). */
export function splitQuoted(text: string): { fresh: string; quoted: string } {
  const lines = text.split('\n');
  const idx = lines.findIndex((l, i) =>
    /^On .{4,200}wrote:\s*$/.test(l) || /^-{2,}\s*Original Message\s*-{2,}/i.test(l) || /^From:\s.+/.test(l) && i > 0 && lines[i - 1]?.trim() === '' ||
    (l.startsWith('>') && lines.slice(i).every((x) => x.startsWith('>') || x.trim() === '')));
  if (idx <= 0) return { fresh: text.trim(), quoted: '' };
  return { fresh: lines.slice(0, idx).join('\n').trim(), quoted: lines.slice(idx).join('\n').trim() };
}
