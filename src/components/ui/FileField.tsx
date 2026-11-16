'use client';

import { useRef } from 'react';

/**
 * File picker that lists what was chosen and lets each file be removed before sending.
 * The native input is cleared after every pick so choosing the same file twice still fires `change`.
 */
export function FileField({ label, hint, accept, files, onChange, max = 5 }: {
  label: string;
  hint?: string;
  accept: string;
  files: File[];
  onChange: (files: File[]) => void;
  max?: number;
}) {
  const input = useRef<HTMLInputElement>(null);

  const add = (picked: FileList | null) => {
    const next = [...files];
    for (const f of Array.from(picked ?? [])) {
      if (next.length >= max) break;
      // The same file twice in one message is a mistake, not a requirement.
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    onChange(next);
    if (input.current) input.current.value = '';
  };

  return (
    <div className="f">
      <span className="lbl">{label}{hint && <small> {hint}</small>}</span>
      <input ref={input} type="file" accept={accept} multiple={max > 1} onChange={(e) => add(e.currentTarget.files)}
        aria-describedby={files.length ? `${label}-list` : undefined} />
      {files.length > 0 && (
        <ul className="filelist" id={`${label}-list`}>
          {files.map((f, i) => (
            <li key={`${f.name}-${f.size}-${i}`}>
              <span className="fname" title={f.name}>{f.name}</span>
              <small>{(f.size / 1024 / 1024).toFixed(1)} MB</small>
              <button type="button" className="x" aria-label={`Remove ${f.name}`}
                onClick={() => onChange(files.filter((_, j) => j !== i))}>×</button>
            </li>
          ))}
        </ul>
      )}
      {files.length >= max && <small className="hint">That is the maximum of {max} files.</small>}
    </div>
  );
}
