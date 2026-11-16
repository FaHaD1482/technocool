import { NextResponse } from 'next/server';
import { query } from '@/lib/db';

/**
 * Liveness/readiness for an uptime monitor. Not behind the session check (proxy.ts exempts /api/health).
 * 200 = database reachable and the worker has checked in during the last 2 minutes; 503 otherwise.
 */
export async function GET() {
  const started = Date.now();
  let db = false;
  let worker: { state: string; lastSeenAt: string | null; ageSeconds: number | null } = { state: 'unknown', lastSeenAt: null, ageSeconds: null };

  try {
    await query('SELECT 1');
    db = true;
    const { rows } = await query(`SELECT state, last_seen_at, extract(epoch from (now() - last_seen_at))::int AS age FROM worker_status WHERE id = 1`);
    if (rows[0]) {
      worker = {
        state: rows[0].state,
        lastSeenAt: rows[0].last_seen_at?.toISOString() ?? null,
        ageSeconds: rows[0].age,
      };
    }
  } catch {
    db = false;
  }

  const live = worker.ageSeconds !== null && worker.ageSeconds < 120;
  // The row keeps whatever the worker last wrote; a killed process still says "running". Report what is true now.
  const state = worker.state === 'unknown' ? 'unknown' : live ? worker.state : 'stale';
  const workerOk = state === 'running';
  const ok = db && workerOk;

  return NextResponse.json(
    { ok, database: db, worker: { ...worker, state }, ms: Date.now() - started, time: new Date().toISOString() },
    { status: ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
