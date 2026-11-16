import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fillTemplate, parseRecipients, plusAddress, withSubjectCode } from './compose';
import { decryptSecret, encryptSecret } from './crypto';
import { GmailAuthError, GmailClient } from './gmail';
import { buildMime, encodeWord, textToHtml } from './mime';

const KEY = randomBytes(32).toString('base64');

describe('token encryption', () => {
  it('round-trips and detects tampering or a wrong key', () => {
    const blob = encryptSecret('1//refresh-token', KEY);
    expect(blob.includes(Buffer.from('refresh-token'))).toBe(false);
    expect(decryptSecret(blob, KEY)).toBe('1//refresh-token');
    const bad = Buffer.from(blob);
    const lastByte = bad.length - 1;
    bad[lastByte] = (bad[lastByte] ?? 0) ^ 1;
    expect(() => decryptSecret(bad, KEY)).toThrow();
    expect(() => decryptSecret(blob, randomBytes(32).toString('base64'))).toThrow();
  });
});

describe('composition', () => {
  it('plus address and subject code', () => {
    expect(plusAddress('ABCcompany@gmail.com', 'boq-2026-0012-r1')).toBe('abccompany+boq-2026-0012-r1@gmail.com');
    expect(withSubjectCode('Price offer: Office', 'BOQ-2026-0012', 1)).toBe('Price offer: Office [BOQ-2026-0012 R1]');
    expect(withSubjectCode('[BOQ-2026-0012 R1] Offer', 'BOQ-2026-0012', 1)).toBe('[BOQ-2026-0012 R1] Offer');
    expect(withSubjectCode('Bad\r\nBcc: x@y.com', 'BOQ-2026-0012', 1)).not.toMatch(/[\r\n]/);
  });
  it('fills templates and drops doubled blank lines from empty values', () => {
    expect(fillTemplate('Dear {contact},\n\n{note}\n\nBye {x}', { contact: 'Mr. Rahman', note: '' })).toBe('Dear Mr. Rahman,\n\nBye {x}');
  });
  it('removes a signature line whose placeholder is empty', () => {
    expect(fillTemplate('Regards,\n{name}\n{designation}\n{company}', { name: 'Alice', designation: null, company: 'ACME' })).toBe('Regards,\nAlice\nACME');
  });
  it('parses recipients', () => {
    expect(parseRecipients('A@x.com; b@y.com, a@x.com  nope')).toEqual({ ok: ['a@x.com', 'b@y.com'], bad: ['nope'] });
  });
});

describe('MIME', () => {
  const raw = buildMime({
    from: { name: 'Technocool Ltd', address: 'boss@gmail.com' }, to: ['client@x.com'], cc: ['eng@y.com'],
    replyTo: 'boss+boq-2026-0012-r1@gmail.com', subject: 'অফার [BOQ-2026-0012 R1]', text: 'Hello\nWorld', html: textToHtml('Hello <b>'),
    messageId: '<t.1@hvac-boq.local>', headers: { 'X-BOQ-Ref': 'BOQ-2026-0012 R1' },
    attachments: [{ filename: 'BOQ-2026-0012 R1 (BDT).xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: Buffer.from('PKfake') }],
  }).toString();

  it('has the tracking headers and the attachment', () => {
    expect(raw).toContain('Reply-To: boss+boq-2026-0012-r1@gmail.com');
    expect(raw).toContain('Message-ID: <t.1@hvac-boq.local>');
    expect(raw).toContain('From: "Technocool Ltd" <boss@gmail.com>');
    expect(raw).toContain('Cc: eng@y.com');
    expect(raw).toContain("filename*=UTF-8''BOQ-2026-0012%20R1%20(BDT).xlsx");
    expect(raw).toContain(Buffer.from('PKfake').toString('base64'));
    expect(raw).toMatch(/Subject: =\?UTF-8\?B\?/);
  });
  it('escapes HTML and refuses header injection', () => {
    expect(textToHtml('<b>')).toContain('&lt;b&gt;');
    expect(() => encodeWord('x\r\nBcc: evil@x.com')).toThrow();
  });
});

describe('Gmail client', () => {
  it('turns invalid_grant into GmailAuthError (sending must pause)', async () => {
    const f = (async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })) as typeof fetch;
    const c = new GmailClient({ clientId: 'id', clientSecret: 's' }, 'rt', f);
    await expect(c.send(Buffer.from('x'))).rejects.toBeInstanceOf(GmailAuthError);
  });
  it('refreshes once and sends with the bearer token', async () => {
    const calls: string[] = [];
    const f = (async (url: string, init?: RequestInit) => {
      calls.push(url);
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }));
      expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer AT');
      return new Response(JSON.stringify({ id: 'm1', threadId: 't1' }));
    }) as typeof fetch;
    const c = new GmailClient({ clientId: 'id', clientSecret: 's' }, 'rt', f);
    expect(await c.send(Buffer.from('x'))).toEqual({ id: 'm1', threadId: 't1' });
    await c.send(Buffer.from('y'));
    expect(calls.filter((u) => u.includes('oauth2')).length).toBe(1);
  });
});
