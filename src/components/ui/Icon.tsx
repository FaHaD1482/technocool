import type { ReactNode, SVGProps } from 'react';

const PATHS = {
  sun: <><circle cx="10" cy="10" r="3.4" /><path d="M10 2.2v1.7M10 16.1v1.7M2.2 10h1.7M16.1 10h1.7M4.4 4.4l1.2 1.2M14.4 14.4l1.2 1.2M15.6 4.4l-1.2 1.2M5.6 14.4l-1.2 1.2" /></>,
  moon: <path d="M15.6 12.7A6.3 6.3 0 0 1 7.3 4.4a6.4 6.4 0 1 0 8.3 8.3z" />,
  monitor: <><rect x="2.5" y="3.5" width="15" height="10" rx="1.5" /><path d="M7 16.5h6M10 13.5v3" /></>,
  menu: <path d="M3 5.5h14M3 10h14M3 14.5h14" />,
  close: <path d="M5 5l10 10M15 5L5 15" />,
  boq: <><path d="M5 3h7l3 3v11H5z" /><path d="M12 3v3h3M7.5 9.5h5M7.5 12.5h5" /></>,
  clients: <><rect x="4" y="3" width="8" height="14" /><path d="M12 8h4v9M3 17h14M6.2 6.5h.01M9.2 6.5h.01M6.2 9.5h.01M9.2 9.5h.01M6.2 12.5h.01M9.2 12.5h.01M14 11h.01M14 14h.01" /></>,
  users: <><circle cx="7.8" cy="7" r="2.6" /><path d="M3.3 16c0-2.4 2-4.2 4.5-4.2s4.5 1.8 4.5 4.2" /><path d="M12.8 5.2a2.4 2.4 0 0 1 0 4.6M14.2 11.9c1.4.6 2.3 1.9 2.3 3.6" /></>,
  mail: <><rect x="2.5" y="4.5" width="15" height="11" rx="1.5" /><path d="m3.2 6 6.8 5 6.8-5" /></>,
  inbox: <><path d="M3 12.5V15h14v-2.5M3 12.5l2.4-8h9.2l2.4 8" /><path d="M3 12.5h4l1 2h4l1-2h4" /></>,
  bell: <path d="M10 2.5a5 5 0 0 0-5 5v3l-1.5 2.5h13L15 10.5v-3a5 5 0 0 0-5-5zM8 15.5a2 2 0 0 0 4 0" />,
  chevron: <path d="m6 8 4 4 4-4" />,
  plus: <path d="M10 4v12M4 10h12" />,
  check: <path d="m4 10.5 4 4 8-9" />,
  alert: <><path d="M10 3.5 17.5 16h-15z" /><path d="M10 8v3.6M10 13.7h.01" /></>,
  external: <><path d="M8 4H4.5v12h12V12" /><path d="M12 3.5h5v5M17 3.5 10 10.5" /></>,
  paperclip: <path d="M12.8 6.4 7.6 11.6a2.2 2.2 0 0 0 3.1 3.1l5.2-5.2a3.5 3.5 0 0 0-5-5L5.7 10a4.6 4.6 0 0 0 6.5 6.5l4.6-4.6" />,
  star: <path d="m10 3 2 4.3 4.7.6-3.4 3.3.8 4.7-4.1-2.2-4.1 2.2.8-4.7L3.3 7.9l4.7-.6z" />,
  'arrow-left': <path d="M16 10H4M9 5l-5 5 5 5" />,
  logout: <path d="M12 4H5v12h7M9 10h8M14 7l3 3-3 3" />,
  search: <><circle cx="9" cy="9" r="5" /><path d="m13 13 4 4" /></>,
  user: <><circle cx="10" cy="7" r="3" /><path d="M4.5 16.5c0-2.8 2.4-4.8 5.5-4.8s5.5 2 5.5 4.8" /></>,
  shield: <path d="M10 2.8 16 5v5c0 3.4-2.4 6-6 7.2C6.4 16 4 13.4 4 10V5z" />,
  settings: <><path d="M3.5 6.5H11M14.5 6.5h2M3.5 13.5h2M7.5 13.5h9" /><circle cx="12.8" cy="6.5" r="2" /><circle cx="5.8" cy="13.5" r="2" /></>,
  send: <><path d="M3.2 9.9 16.8 4.2l-4 12.2-3-4.9z" /><path d="m9.8 11.5 7-7.3" /></>,
  reply: <path d="M8 5 3.5 9.5 8 14M4 9.5h6.2c3.2 0 5.3 1.9 5.8 4.8" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

/** One inline-SVG icon set, sized by font size context. Purely decorative: always pair with a label. */
export function Icon({ name, size = 18, ...rest }: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {PATHS[name]}
    </svg>
  );
}
