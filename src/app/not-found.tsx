import Link from 'next/link';

export const metadata = { title: 'Not found' };

export default function RootNotFound() {
  return (
    <main className="authpage">
      <div className="authcard">
        <div className="brandmark"><span className="logo">BQ</span><b>HVAC BOQ</b></div>
        <h1>Not found</h1>
        <p className="hint">That page does not exist. Sign in and start from your BOQs.</p>
        <Link className="btn primary" href="/boqs">Go to BOQs</Link>
      </div>
    </main>
  );
}
