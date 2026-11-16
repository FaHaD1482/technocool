import Link from 'next/link';
import { ThemeToggle } from '@/components/layout/ThemeToggle';

export const metadata = { title: 'Not allowed' };

export default function Forbidden() {
  return (
    <main className="authpage">
      <div className="auth-theme"><ThemeToggle /></div>
      <div className="authcard">
        <div className="brandmark"><span className="logo">BQ</span><b>HVAC BOQ</b></div>
        <h1>Not allowed</h1>
        <p className="hint">Your role does not include this page. Ask the admin if you need access.</p>
        <Link className="btn primary" href="/boqs">Back to my BOQs</Link>
      </div>
    </main>
  );
}
