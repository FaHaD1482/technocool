import Link from 'next/link';

export const metadata = { title: 'Not found' };

export default function NotFound() {
  return (
    <main className="wrap page page-narrow">
      <div className="card empty-state">
        <h2>Not found</h2>
        <p>That page does not exist, or it belongs to someone else.</p>
        <Link className="btn primary" href="/boqs">Back to BOQs</Link>
      </div>
    </main>
  );
}
