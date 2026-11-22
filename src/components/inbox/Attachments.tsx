'use client';

import { useRef } from 'react';
import { Icon } from '@/components/ui/Icon';

export const ATTACH_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.png,.jpg,.jpeg,.gif,.webp,.zip';
export const ATTACH_HINT = 'PDF, Word, Excel, CSV, TXT, images, ZIP · 5 files · 10 MB each · 20 MB total';
export const ATTACH_MAX = 5;

/** Adds picked files, skipping duplicates and anything over the limit. */
export function addFiles(current: File[], picked: FileList | null, max = ATTACH_MAX): File[] {
  const next = [...current];
  for (const f of Array.from(picked ?? [])) {
    if (next.length >= max) break;
    if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
  }
  return next;
}

/** The paper-clip button in the compose toolbar (Gmail's "Attach files"). */
export function AttachButton({ files, onChange }: { files: File[]; onChange: (f: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const full = files.length >= ATTACH_MAX;
  return (
    <>
      <button type="button" className="m-icon" onClick={() => input.current?.click()} disabled={full}
        title={full ? `Maximum ${ATTACH_MAX} files` : `Attach files (${ATTACH_HINT})`} aria-label="Attach files">
        <Icon name="paperclip" size={18} />
      </button>
      <input ref={input} type="file" accept={ATTACH_ACCEPT} multiple hidden
        onChange={(e) => { onChange(addFiles(files, e.currentTarget.files)); e.currentTarget.value = ''; }} />
    </>
  );
}

/** Chosen files as removable chips above the toolbar. */
export function AttachChips({ files, onChange }: { files: File[]; onChange: (f: File[]) => void }) {
  if (!files.length) return null;
  return (
    <ul className="m-chips" aria-label="Attachments">
      {files.map((f, i) => (
        <li key={`${f.name}-${f.size}-${i}`} className="m-chip">
          <Icon name="file" size={15} />
          <span className="m-chip-name" title={f.name}>{f.name}</span>
          <small>({Math.max(1, Math.round(f.size / 1024))} KB)</small>
          <button type="button" className="x" aria-label={`Remove ${f.name}`}
            onClick={() => onChange(files.filter((_, j) => j !== i))}>×</button>
        </li>
      ))}
    </ul>
  );
}
