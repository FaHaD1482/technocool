/** Pure helpers for an outgoing BOQ e-mail: tracking marks, templates, recipients. */
import { subjectCode, tagFor } from './match';
import type { ExportChoice } from '@/lib/boq/types';

export { subjectCode, tagFor };

/** abccompany@gmail.com + boq-2026-0012-r1 -> abccompany+boq-2026-0012-r1@gmail.com */
export function plusAddress(mailbox: string, tag: string): string {
  const [local, domain] = mailbox.toLowerCase().split('@');
  if (!local || !domain) throw new Error('Mailbox address is not valid.');
  return `${local.split('+')[0]}+${tag}@${domain}`;
}

/** The subject always carries the code; if the employee removed it, it is added back at the end. */
export function withSubjectCode(subject: string, boqNo: string, revision: number): string {
  const code = subjectCode(boqNo, revision);
  const s = subject.replace(/[\r\n]+/g, ' ').trim();
  return s.includes(code) ? s : `${s} ${code}`.trim();
}

export function messageIdFor(tag: string, domain = 'hvac-boq.local', rand = crypto.randomUUID()) {
  return `<${tag}.${rand}@${domain}>`;
}

export function currencyNote(choice: ExportChoice): string {
  if (choice === 'BOTH') return 'Two editable Excel files are attached: one in US Dollars and one in Taka.';
  return choice === 'USD' ? 'The editable Excel offer (US Dollar) is attached.' : 'The editable Excel offer (Taka) is attached.';
}

/**
 * Replaces {placeholders}; unknown ones are left as they are. A line that only held empty placeholders
 * (e.g. no designation) is removed, and doubled blank lines collapse.
 */
export function fillTemplate(tpl: string, vars: Record<string, string | null | undefined>): string {
  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? (vars[k] ?? '') : m));
  return tpl.replace(/\r\n/g, '\n').split('\n')
    .flatMap((line) => {
      const out = fill(line);
      return out.trim() === '' && line.trim() !== '' ? [] : out.split('\n');
    })
    .filter((line, i, all) => !(line.trim() === '' && (all[i - 1] ?? '').trim() === ''))
    .join('\n').replace(/\n+$/, '');
}

const EMAIL = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;
/** "a@x.com, b@y.com; c@z.com" -> clean, unique, lower-case list; returns the bad ones too. */
export function parseRecipients(raw: string): { ok: string[]; bad: string[] } {
  const parts = raw.split(/[,;\s]+/).map((s) => s.trim().replace(/^<|>$/g, '').toLowerCase()).filter(Boolean);
  const ok = [...new Set(parts.filter((p) => EMAIL.test(p)))];
  return { ok, bad: parts.filter((p) => !EMAIL.test(p)) };
}
