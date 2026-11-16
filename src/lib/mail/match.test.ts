import { describe, expect, it } from 'vitest';
import { isAutoReply, matchReply, parseSubjectCode, plusTag, tagFor, type Inbound, type MatchContext, type SentEmail } from './match';

const sent = (p: Partial<SentEmail>): SentEmail => ({
  id: 'e1', boqId: 'b1', boqNo: 'BOQ-2026-0012', revision: 1, ownerId: 'u1', tag: 'boq-2026-0012-r1',
  gmailThreadId: 'T1', rfcMessageId: '<abc@hvac>', sentAt: new Date('2026-11-01'), ...p,
});
const msg = (p: Partial<Inbound>): Inbound => ({
  threadId: 'NEW', inReplyTo: null, references: null, to: ['abccompany@gmail.com'], cc: [], subject: 'Hello', from: 'client@x.com', ...p,
});
const ctx = (s: SentEmail[], open: SentEmail[] = []): MatchContext => ({ sent: s, openBoqsBySender: () => open, mailboxLocalPart: 'abccompany' });

describe('reply matching, in the plan order', () => {
  const a = sent({});
  const b = sent({ id: 'e2', boqId: 'b2', boqNo: 'BOQ-2026-0020', revision: 0, tag: 'boq-2026-0020-r0', gmailThreadId: 'T2', rfcMessageId: '<def@hvac>' });

  it('1. Gmail thread wins over everything', () => {
    expect(matchReply(msg({ threadId: 'T2', subject: '[BOQ-2026-0012 R1]' }), ctx([a, b]))).toMatchObject({ method: 'thread', email: { id: 'e2' } });
  });
  it('2. In-Reply-To / References header', () => {
    expect(matchReply(msg({ inReplyTo: '<ABC@hvac>' }), ctx([a, b]))).toMatchObject({ method: 'header', email: { id: 'e1' } });
    expect(matchReply(msg({ references: '<zzz@x> <def@hvac>' }), ctx([a, b]))).toMatchObject({ method: 'header', email: { id: 'e2' } });
  });
  it('3. plus-address tag (Gmail ignores dots in the local part)', () => {
    expect(matchReply(msg({ to: ['ABC Company <abc.company+boq-2026-0020-r0@gmail.com>'] }), ctx([a, b]))).toMatchObject({ method: 'plus_tag', email: { id: 'e2' } });
  });
  it('4. BOQ code in a changed subject', () => {
    expect(matchReply(msg({ subject: 'RE: price for boq 2026-0012 r1 please' }), ctx([a, b]))).toMatchObject({ method: 'subject_code', email: { id: 'e1' } });
    expect(matchReply(msg({ subject: 'Fwd: BOQ-2026-0020 query' }), ctx([a, b]))).toMatchObject({ method: 'subject_code', email: { id: 'e2' } });
  });
  it('5. sender only when the client has exactly one open BOQ', () => {
    expect(matchReply(msg({}), ctx([a, b], [a]))).toMatchObject({ method: 'sender', email: { id: 'e1' } });
    expect(matchReply(msg({}), ctx([a, b], [a, b]))).toBeNull();
  });
  it('6. otherwise unmatched', () => {
    expect(matchReply(msg({}), ctx([a, b]))).toBeNull();
  });
});

describe('conversations (general / official mail)', () => {
  const thread = { id: 'th1', ownerId: 'u1', tag: 'c-1234abcd', gmailThreadId: 'G9', boqNo: null, subject: 'Site visit' };
  const cctx = (extra: Partial<MatchContext> = {}): MatchContext => ({
    sent: [], openBoqsBySender: () => [], mailboxLocalPart: 'abccompany',
    threads: [thread], threadMessages: [{ id: 'm1', threadId: 'th1', rfcMessageId: '<mail-1@hvac>' }], ...extra,
  });

  it('matches the Gmail thread of the conversation', () => {
    expect(matchReply(msg({ threadId: 'G9' }), cctx())).toMatchObject({ method: 'thread', thread: { id: 'th1' } });
  });
  it('matches a reply header pointing at a general message', () => {
    expect(matchReply(msg({ inReplyTo: '<MAIL-1@hvac>' }), cctx())).toMatchObject({ method: 'header', thread: { id: 'th1' }, threadMessageId: 'm1' });
  });
  it('matches the conversation plus tag', () => {
    expect(matchReply(msg({ to: ['abccompany+c-1234abcd@gmail.com'] }), cctx())).toMatchObject({ method: 'plus_tag', thread: { id: 'th1' } });
  });
  it('a conversation tag wins over the “one open BOQ” heuristic', () => {
    const a = sent({});
    expect(matchReply(msg({ to: ['abccompany+c-1234abcd@gmail.com'] }), cctx({ sent: [a], openBoqsBySender: () => [a] })))
      .toMatchObject({ method: 'plus_tag', thread: { id: 'th1' } });
  });
  it('a BOQ reply still matches the BOQ, not the conversation', () => {
    const a = sent({});
    expect(matchReply(msg({ inReplyTo: '<abc@hvac>' }), cctx({ sent: [a] }))).toMatchObject({ method: 'header', email: { id: 'e1' } });
  });
});

describe('sender trust gate', () => {
  it('an unknown sender cannot use the weakly-authenticated BOQ rules', () => {
    const a = sent({});
    const c: MatchContext = { ...ctx([a]), isKnownSender: false };
    expect(matchReply(msg({ to: ['abccompany+boq-2026-0012-r1@gmail.com'] }), c)).toBeNull();
    expect(matchReply(msg({ subject: '[BOQ-2026-0012 R1]' }), c)).toBeNull();
    expect(matchReply(msg({}), { ...c, openBoqsBySender: () => [a] })).toBeNull();
  });
  it('thread and header matches still work for an unknown sender (they need the real ids)', () => {
    const c: MatchContext = { ...ctx([sent({})]), isKnownSender: false };
    expect(matchReply(msg({ threadId: 'T1' }), c)).toMatchObject({ method: 'thread' });
    expect(matchReply(msg({ inReplyTo: '<abc@hvac>' }), c)).toMatchObject({ method: 'header' });
  });
  it('a plus tag on another domain does not match', () => {
    const c: MatchContext = { ...ctx([sent({})]), mailboxDomain: 'gmail.com' };
    expect(matchReply(msg({ to: ['abccompany+boq-2026-0012-r1@evil.example'] }), c)).toBeNull();
    expect(matchReply(msg({ to: ['abccompany+boq-2026-0012-r1@gmail.com'] }), c)).toMatchObject({ method: 'plus_tag' });
  });
});

describe('helpers', () => {
  it('builds and reads tags', () => {
    const t = tagFor('BOQ-2026-0012', 1);
    expect(t).toMatch(/^b-[0-9a-f]{10}$/);                       // random-looking, not derivable from the BOQ number
    expect(tagFor('BOQ-2026-0012', 1)).toBe(t);                  // stable for the same send
    expect(tagFor('BOQ-2026-0012', 2)).not.toBe(t);
    expect(plusTag('abccompany+b-0123456789@gmail.com', 'abccompany')).toBe('b-0123456789');
    expect(plusTag('someoneelse+b-0123456789@gmail.com', 'abccompany')).toBeNull();
    expect(plusTag('abccompany+b-0123456789@evil.example', 'abccompany', 'gmail.com')).toBeNull();
  });
  it('parses subject codes', () => {
    expect(parseSubjectCode('[BOQ-2026-0012 R1] Offer')).toEqual({ boqNo: 'BOQ-2026-0012', revision: 1 });
    expect(parseSubjectCode('boq-2026-12')).toEqual({ boqNo: 'BOQ-2026-0012', revision: null });
    expect(parseSubjectCode('no code')).toBeNull();
  });
  it('detects auto-replies', () => {
    expect(isAutoReply({ 'auto-submitted': 'auto-replied' })).toBe(true);
    expect(isAutoReply({ subject: 'Out of office: back Monday' })).toBe(true);
    expect(isAutoReply({ subject: 'RE: [BOQ-2026-0012 R1]' })).toBe(false);
  });
});
