/**
 * Reply matching (plan: "Matching a reply, in this order"). Pure logic: the worker loads the candidate
 * rows and this decides. Each rule is tried in order and the first hit wins:
 *   1. Gmail threadId                     the client pressed Reply
 *   2. In-Reply-To / References           a mail client that keeps headers but starts a new thread
 *   3. Plus-address tag in To / Cc        abccompany+boq-2026-0012-r1@gmail.com
 *   4. BOQ code in the subject            [BOQ-2026-0012 R1], also "BOQ-2026-0012" without a revision
 *   5. Sender address                     only when that client has exactly one open BOQ
 *   6. otherwise unmatched                admin-only list with an Assign button
 */
import { createHmac } from 'node:crypto';

export type MatchMethod = 'thread' | 'header' | 'plus_tag' | 'subject_code' | 'sender';

export interface SentEmail {
  id: string;
  boqId: string;
  boqNo: string;
  revision: number;
  ownerId: string | null;
  tag: string;
  gmailThreadId: string | null;
  rfcMessageId: string | null;
  sentAt: Date;
  threadId?: string | null;
}

/** A conversation the worker pre-loaded, so replies can attach to general mail (not only to a BOQ). */
export interface ThreadCandidate {
  id: string;
  ownerId: string | null;
  tag: string;
  gmailThreadId: string | null;
  boqNo: string | null;
  subject: string;
}

export interface ThreadMessageRef { id: string; threadId: string; rfcMessageId: string | null }

export interface Inbound {
  threadId: string;
  inReplyTo: string | null;
  references: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  from: string;
}

/** Exactly one of `email` (BOQ mail) or `thread` (conversation) is set. */
export interface MatchResult { method: MatchMethod; email?: SentEmail; thread?: ThreadCandidate; threadMessageId?: string }

export interface MatchContext {
  sent: SentEmail[];                                        // sent rows that could match (worker pre-filters)
  openBoqsBySender: (from: string) => SentEmail[];          // latest send per open BOQ for the client with this address
  mailboxLocalPart: string;                                  // "abccompany" of abccompany@gmail.com
  threads?: ThreadCandidate[];                               // conversations that could match
  threadMessages?: ThreadMessageRef[];                       // outbound general messages whose Message-ID could match
  /** false = the sender is not a known client (or failed SPF/DKIM): only thread/header rules may match. */
  isKnownSender?: boolean;
  /** the company mailbox domain; a plus tag must use it, not any domain that happens to carry the tag. */
  mailboxDomain?: string;
}

const norm = (s: string) => s.trim().toLowerCase();
const stripAngles = (s: string) => s.trim().replace(/^<|>$/g, '').toLowerCase();

/** Every Message-ID in an In-Reply-To / References header. */
export function messageIds(header: string | null): string[] {
  if (!header) return [];
  return (header.match(/<[^<>\s]+>/g) ?? []).map(stripAngles);
}

/** "Name <a+tag@x.com>" -> "a+tag@x.com" */
export function addressOf(s: string): string {
  const m = s.match(/<([^<>]+)>/);
  return norm(m?.[1] ?? s);
}

/** Tag from a plus address to our own mailbox: abccompany+boq-2026-0012-r1@gmail.com -> boq-2026-0012-r1 */
export function plusTag(address: string, localPart: string, domain?: string): string | null {
  const a = addressOf(address);
  const [, local, tag, host] = a.match(/^([^+@]+)\+([^@]+)@([^@\s]+)$/) ?? [];
  if (!local || !tag || !host) return null;
  if (local.replace(/\./g, '') !== localPart.replace(/\./g, '').toLowerCase()) return null;   // Gmail ignores dots
  if (domain && host.replace(/\.$/, '').toLowerCase() !== domain.replace(/\.$/, '').toLowerCase()) return null;
  return tag;
}

/**
 * Tracking tag for a BOQ send. Keyed with the server secret so it cannot be derived from the BOQ number
 * (an enumerable tag let anyone post a fake "client reply" into a real thread).
 */
export function tagFor(boqNo: string, revision: number) {
  const key = process.env.GMAIL_TOKEN_KEY ?? 'hvac-boq-local-tag';
  return `b-${createHmac('sha256', key).update(`${boqNo}-r${revision}`).digest('hex').slice(0, 10)}`;
}

export function subjectCode(boqNo: string, revision: number) {
  return `[${boqNo} R${revision}]`;
}

/** BOQ number and optional revision from a subject; tolerant of spaces, dashes and case. */
export function parseSubjectCode(subject: string | null): { boqNo: string; revision: number | null } | null {
  if (!subject) return null;
  const m = subject.match(/BOQ[\s-]?(\d{4})[\s-]?(\d{1,6})(?:\s*[-\s]?R\s?(\d{1,3}))?/i);
  if (!m) return null;
  const [, year, seq, rev] = m;
  if (!year || !seq) return null;
  return { boqNo: `BOQ-${year}-${seq.padStart(4, '0')}`, revision: rev ? Number(rev) : null };
}

const latest = (list: SentEmail[]) => [...list].sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime())[0];

export function matchReply(msg: Inbound, ctx: MatchContext): MatchResult | null {
  const { sent } = ctx;

  // 1. Gmail thread
  const byThread = sent.filter((s) => s.gmailThreadId && s.gmailThreadId === msg.threadId);
  if (byThread.length) return { method: 'thread', email: latest(byThread) };

  // 2. In-Reply-To / References (newest reference first)
  const refs = [...messageIds(msg.inReplyTo), ...messageIds(msg.references).reverse()];
  for (const id of refs) {
    const hit = sent.find((s) => s.rfcMessageId && stripAngles(s.rfcMessageId) === id);
    if (hit) return { method: 'header', email: hit };
  }

  // 3.-5. Weak rules: they trust headers the sender controls (plus tag, subject, From). Only a known client
  // (and a sender that passed SPF/DKIM) may use them, otherwise anyone could post into a real client thread.
  const trustworthy = ctx.isKnownSender !== false;
  if (trustworthy) {
    // 3. Plus-address tag
    for (const addr of [...msg.to, ...msg.cc]) {
      const tag = plusTag(addr, ctx.mailboxLocalPart, ctx.mailboxDomain);
      if (!tag) continue;
      const hits = sent.filter((s) => norm(s.tag) === norm(tag));
      if (hits.length) return { method: 'plus_tag', email: latest(hits) };
    }

    // 4. BOQ code in the subject (exact revision if given, else the latest send of that BOQ number)
    const code = parseSubjectCode(msg.subject);
    if (code) {
      const hits = sent.filter((s) => s.boqNo === code.boqNo && (code.revision === null || s.revision === code.revision));
      if (hits.length) return { method: 'subject_code', email: latest(hits) };
    }
  }

  // 4b. Conversations (general/official mail): thread, reply headers, then the conversation's plus tag.
  // These run before the BOQ "single open BOQ" heuristic so a general reply is never stolen by a BOQ.
  const threads = ctx.threads ?? [];
  const byConvThread = threads.find((t) => t.gmailThreadId && t.gmailThreadId === msg.threadId);
  if (byConvThread) return { method: 'thread', thread: byConvThread };
  for (const id of refs) {
    const ref = ctx.threadMessages?.find((m) => m.rfcMessageId && stripAngles(m.rfcMessageId) === id);
    const hit = ref ? threads.find((t) => t.id === ref.threadId) : undefined;
    if (hit) return { method: 'header', thread: hit, threadMessageId: ref!.id };
  }
  if (trustworthy) {
    for (const addr of [...msg.to, ...msg.cc]) {
      const tag = plusTag(addr, ctx.mailboxLocalPart, ctx.mailboxDomain);
      if (!tag) continue;
      const hit = threads.find((t) => norm(t.tag) === norm(tag));
      if (hit) return { method: 'plus_tag', thread: hit };
    }

    // 5. Sender, only if exactly one open BOQ for that client
    const open = ctx.openBoqsBySender(addressOf(msg.from));
    const distinct = new Map(open.map((s) => [s.boqId, s]));
    if (distinct.size === 1) return { method: 'sender', email: [...distinct.values()][0] };
  }

  return null;   // 6. unmatched
}

/** Auto-replies and bulk mail are ignored (never stored). */
export function isAutoReply(headers: Record<string, string | undefined>): boolean {
  const h = (k: string) => (headers[k.toLowerCase()] ?? '').toLowerCase();
  if (h('auto-submitted') && h('auto-submitted') !== 'no') return true;
  if (h('x-autoreply') || h('x-autorespond') || h('x-auto-response-suppress').includes('all')) return true;
  if (['bulk', 'junk', 'list', 'auto_reply'].includes(h('precedence'))) return true;
  return /^(auto(matic)? reply|out of (the )?office|autoreply|delivery status notification|undeliverable)/i.test(headers['subject'] ?? '');
}
