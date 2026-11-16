'use client';

import Link from 'next/link';

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="wrap page page-narrow">
      <div className="card empty-state">
        <h2>Something went wrong</h2>
        <p>That page could not be loaded. Your saved work is not affected.</p>
        {error.digest && <p className="hint mono">Reference: {error.digest}</p>}
        <div className="formactions" style={{ justifyContent: 'center', marginTop: 14 }}>
          <button className="btn primary" type="button" onClick={reset}>Try again</button>
          <Link className="btn" href="/boqs">Back to BOQs</Link>
        </div>
      </div>
    </main>
  );
}
