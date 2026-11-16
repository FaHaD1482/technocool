import { describe, expect, it } from 'vitest';
import type { GmailMessage } from './gmail';
import { addressList, displayName, headerMap, htmlToText, parseBody, splitQuoted } from './parse';

const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('headers', () => {
  it('reads address lists with display names and repeated headers', () => {
    expect(addressList('"Rahman, A." <A@X.com>, b@y.com; c@z.com')).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
    expect(displayName('"Mr. Rahman" <a@x.com>')).toBe('Mr. Rahman');
    expect(displayName('a@x.com')).toBeNull();
    const m: GmailMessage = { id: '1', threadId: 't', payload: { headers: [{ name: 'Delivered-To', value: 'a@x.com' }, { name: 'Delivered-To', value: 'a+tag@x.com' }] } };
    expect(addressList(headerMap(m)['delivered-to'])).toEqual(['a@x.com', 'a+tag@x.com']);
  });
});

describe('body', () => {
  it('prefers text/plain, lists attachments, falls back to HTML', () => {
    const m: GmailMessage = {
      id: '1', threadId: 't', payload: {
        mimeType: 'multipart/mixed', parts: [
          { mimeType: 'multipart/alternative', parts: [
            { mimeType: 'text/plain', body: { data: b64('Thanks, please revise.\n\nOn Mon, 3 Nov 2026 at 10:00, ABC <abc@gmail.com> wrote:\n> old') } },
            { mimeType: 'text/html', body: { data: b64('<p>Thanks</p>') } },
          ] },
          { mimeType: 'application/pdf', filename: 'Site plan/v2.pdf', body: { attachmentId: 'A1', size: 1234 } },
        ],
      },
    };
    const p = parseBody(m);
    expect(p.text.startsWith('Thanks, please revise.')).toBe(true);
    expect(p.attachments).toEqual([{ filename: 'Site plan_v2.pdf', mimeType: 'application/pdf', size: 1234, attachmentId: 'A1' }]);
    const htmlOnly = parseBody({ id: '2', threadId: 't', payload: { mimeType: 'text/html', body: { data: b64('<div>Price ok<br>Regards</div><script>x</script>') } } });
    expect(htmlOnly.text).toBe('Price ok\nRegards');
  });
  it('turns HTML into text safely', () => {
    expect(htmlToText('<style>a{}</style><p>A &amp; B</p><p>&lt;b&gt;</p>')).toBe('A & B\n<b>');
  });
  it('splits the quoted part of a reply', () => {
    const s = splitQuoted('Please reduce the price.\n\nOn Mon, 3 Nov 2026 at 10:00, ABC <abc@gmail.com> wrote:\n> Dear Sir');
    expect(s.fresh).toBe('Please reduce the price.');
    expect(s.quoted).toMatch(/^On Mon/);
    expect(splitQuoted('No quote here').quoted).toBe('');
  });
});
