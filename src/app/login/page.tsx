import { redirect } from 'next/navigation';
import { ThemeToggle } from '@/components/layout/ThemeToggle';
import { getCurrentUser } from '@/lib/auth/session';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentUser()) redirect('/boqs');
  const { next } = await searchParams;
  return (
    <main className="authpage">
      <div className="auth-theme"><ThemeToggle /></div>
      <LoginForm next={next} />
    </main>
  );
}
