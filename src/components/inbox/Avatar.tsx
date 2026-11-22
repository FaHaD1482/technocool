/** Round initial avatar like Gmail's: the colour is stable per name, so the same client always looks the same. */
const HUES = [4, 28, 45, 145, 175, 200, 220, 262, 290, 330];

export function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  const clean = name.trim() || '?';
  let h = 0;
  for (const ch of clean.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = HUES[h % HUES.length];
  return (
    <span className="m-avatar" aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: `hsl(${hue} 55% 42%)` }}>
      {clean[0]!.toUpperCase()}
    </span>
  );
}
