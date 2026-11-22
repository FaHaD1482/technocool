import type { Metadata, Viewport } from 'next';
import { Barlow_Semi_Condensed, Source_Sans_3 } from 'next/font/google';
import './globals.css';

const display = Barlow_Semi_Condensed({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-display' });
const body = Source_Sans_3({ subsets: ['latin'], weight: ['400', '600', '700'], variable: '--font-body' });

export const metadata: Metadata = {
  title: { default: 'HVAC BOQ', template: '%s · HVAC BOQ' },
  description: 'Build, export and send HVAC BOQs.',
  robots: { index: false, follow: false },
};
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#EEF2F4' },
    { media: '(prefers-color-scheme: dark)', color: '#0F171C' },
  ],
};

/**
 * Applies the saved theme and rail width before the first paint, so a dark-mode reload never flashes
 * white and the rail never jumps. Kept tiny and dependency-free.
 */
const boot = `(function(){try{var d=document.documentElement,t=localStorage.getItem('hvac-theme');if(t==='light'||t==='dark'){d.dataset.theme=t}else{delete d.dataset.theme}d.dataset.nav=localStorage.getItem('hvac-nav')==='closed'?'closed':'open'}catch(e){}})()`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${display.variable} ${body.variable}`}>
      {/* Browser extensions (VPN / security add-ons) stamp attributes on <body> before React loads. */}
      <body suppressHydrationWarning>
        <script dangerouslySetInnerHTML={{ __html: boot }} />
        {children}
      </body>
    </html>
  );
}
