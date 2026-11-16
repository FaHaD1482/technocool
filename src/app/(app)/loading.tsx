/** Shown while a page in the signed-in area loads, so navigation never looks like a dead click. */
export default function Loading() {
  return (
    <main className="wrap page" aria-busy="true">
      <span className="sr">Loading…</span>
      <div className="skel-page" aria-hidden="true">
        <div className="skel" style={{ height: 30, width: 'min(38%, 320px)' }} />
        <div className="skel" style={{ height: 16, width: 'min(62%, 520px)' }} />
        <div className="skel" style={{ height: 38, width: 'min(100%, 420px)', marginTop: 6 }} />
        <div className="skel" style={{ height: 200, marginTop: 6 }} />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="skel-row">
            <div className="skel" style={{ height: 16 }} />
            <div className="skel" style={{ height: 16 }} />
            <div className="skel" style={{ height: 16 }} />
            <div className="skel" style={{ height: 16, display: 'none' }} />
          </div>
        ))}
      </div>
    </main>
  );
}
