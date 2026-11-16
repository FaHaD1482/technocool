'use client';

import { useState, type InputHTMLAttributes } from 'react';

const Eye = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M2 10s2.8-5 8-5 8 5 8 5-2.8 5-8 5-8-5-8-5z" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="10" cy="10" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
);

const EyeOff = () => (
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <path d="M3 3l14 14M8.2 5.3A8.5 8.5 0 0 1 10 5c5.2 0 8 5 8 5a14 14 0 0 1-3.2 3.4M5.4 6.6A13.8 13.8 0 0 0 2 10s2.8 5 8 5c1 0 1.9-.2 2.7-.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M8.4 8.4a2.3 2.3 0 0 0 3.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

/** Password input with a show/hide button. Drop-in replacement for a `.f` input. */
export function PasswordInput({ type: _type, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  const label = show ? 'Hide password' : 'Show password';
  return (
    <span className="pw">
      <input {...props} type={show ? 'text' : 'password'} />
      <button type="button" className="ib" onClick={() => setShow(!show)} aria-label={label} title={label} aria-pressed={show}>
        {show ? <EyeOff /> : <Eye />}
      </button>
    </span>
  );
}
