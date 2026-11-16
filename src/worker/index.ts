/**
 * Background worker:  npm run worker   (keep it running next to the web app, e.g. with pm2 or a Windows service)
 *  - sends queued BOQ e-mails: wakes on pg NOTIFY 'boq_mail', and checks every 15 s anyway;
 *  - reads client replies every 90 s, or at once when Gmail push (Pub/Sub) arrives via NOTIFY 'boq_mail_in'.
 *  npm run worker -- --once   processes what is due (sends + one reply sync) and exits.
 */
import path from 'node:path';
import pg from 'pg';
import { resolveOAuthConfig, type Sql } from '@/lib/mail/config-core';
import { GmailClient } from '@/lib/mail/gmail';
import { processOne, recoverStuck, resetClientCache, type WorkerDeps } from './process';
import { renewWatch, syncReplies } from './replies';

const POLL_MS = 15_000;
const REPLY_MS = Math.max(30, Number(process.env.REPLY_POLL_SECONDS) || 90) * 1000;
const ONCE = process.argv.includes('--once');
const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');
  if (!process.env.GMAIL_TOKEN_KEY) throw new Error('GMAIL_TOKEN_KEY is not set.');

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, application_name: 'hvac-boq-worker' });
  const storageDir = path.resolve(process.env.STORAGE_DIR || './storage');
  const sql: Sql = (text, params) => pool.query(text, params as any[]);

  let wake: (() => void) | null = null;
  let replyDue = true;
  const listener = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'hvac-boq-worker-listen' });
  await listener.connect();
  await listener.query('LISTEN boq_mail');
  await listener.query('LISTEN boq_mail_in');
  listener.on('notification', (n) => { if (n.channel === 'boq_mail_in') replyDue = true; wake?.(); });
  listener.on('error', (e) => { log(`listener error: ${e.message}`); process.exit(1); });   // the service manager restarts us

  let stopping = false;
  const stop = () => { stopping = true; wake?.(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let lastReply = 0;
  // Settings saved in Admin → Gmail are picked up here, without restarting the worker.
  let lastConfigKey = '';
  let warned = false;
  let lastBeat = 0;

  /** A row the admin page and /api/health can read: without it a dead worker looks like an empty queue. */
  const heartbeat = async (state: 'running' | 'stopped', detail?: string) => {
    await pool.query(
      `INSERT INTO worker_status (id, last_seen_at, started_at, state, detail) VALUES (1, now(), now(), $1, $2)
       ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), state = EXCLUDED.state, detail = EXCLUDED.detail`,
      [state, detail ?? null]).catch(() => {});
  };
  const markStopped = () => { void heartbeat('stopped', 'The worker was stopped.'); };
  process.on('exit', markStopped);

  await heartbeat('running');
  log('worker started');
  while (!stopping) {
    try {
      if (Date.now() - lastBeat > 30_000) { lastBeat = Date.now(); await heartbeat('running'); }
      const cfg = await resolveOAuthConfig(sql);
      const key = cfg ? `${cfg.clientId}|${cfg.clientSecret}|${cfg.redirectUri}` : '';
      if (key !== lastConfigKey) { lastConfigKey = key; resetClientCache(); warned = false; }
      if (!cfg && !warned) {
        warned = true;
        log('Google OAuth is not configured yet (Admin → Gmail or GOOGLE_CLIENT_ID / SECRET): mail waits until it is.');
      }
      const deps: WorkerDeps = {
        pool,
        storageDir,
        makeClient: (rt) => new GmailClient(cfg ?? { clientId: '', clientSecret: '', redirectUri: '' }, rt),
        log,
      };
      await recoverStuck(deps);
      if (cfg) {
        let r;
        do { r = await processOne(deps); } while (!stopping && (r === 'sent' || r === 'failed' || r === 'retry'));
        if (replyDue || Date.now() - lastReply >= REPLY_MS || ONCE) {
          replyDue = false;
          lastReply = Date.now();
          await renewWatch(deps, process.env.GMAIL_PUBSUB_TOPIC);
          const s = await syncReplies(deps);
          if (s && (s.matched || s.unmatched)) log(`replies: ${s.matched} matched, ${s.unmatched} unmatched, ${s.ignored} ignored`);
        }
      }
    } catch (e) {
      log(`loop error: ${(e as Error).message}`);
    }
    if (ONCE) break;
    await new Promise<void>((res) => { const t = setTimeout(res, POLL_MS); wake = () => { clearTimeout(t); res(); }; });
    wake = null;
  }
  await heartbeat('stopped', 'Stopped cleanly.');
  await listener.end();
  await pool.end();
  log('worker stopped');
}

main().catch((e) => { console.error(e); process.exit(1); });
