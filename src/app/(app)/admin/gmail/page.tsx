import Link from 'next/link';
import { requirePermission } from '@/lib/auth/session';
import { query } from '@/lib/db';
import { dailyUsage, getMailStatus } from '@/lib/mail/account';
import { readMailConfig } from '@/lib/mail/config';
import { fmtDateTime } from '@/lib/format';
import { EMAIL_STATUS, chipOf, labelOf } from '@/lib/labels';
import { DisconnectButton } from './DisconnectButton';
import { SettingsForm } from './SettingsForm';
import { TemplateForm } from './TemplateForm';

export const metadata = { title: 'Gmail' };

const ERRORS: Record<string, string> = {
  not_configured: 'Gmail is not set up yet. Fill in the Google OAuth client below, then press Connect.',
  state: 'The sign-in could not be verified (it took too long or was opened in another tab). Try again.',
  access_denied: 'Access was not allowed on the Google screen. Try again and allow all requested access.',
  no_refresh_token: 'Google did not give a lasting token. Remove this app at myaccount.google.com → Security → Third-party access, then connect again.',
  scopes: 'Not all access was allowed. Connect again and tick both “send” and “read” boxes.',
  wrong_account: 'That is not the company Gmail saved in the settings above.',
  exchange: 'Google refused the sign-in. Check the client ID, the secret and the redirect URI.',
  forbidden: 'Only the admin can connect Gmail.',
};

export default async function GmailPage({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string; got?: string }> }) {
  await requirePermission('integrations.gmail.manage');
  const sp = await searchParams;
  const [mail, daily, config, settings, sends, queue, worker] = await Promise.all([
    getMailStatus(), dailyUsage(), readMailConfig(),
    query(`SELECT company_name, email_from_name, email_subject_template, email_body_template FROM company_settings WHERE id = 1`),
    query(`SELECT * FROM (
             SELECT e.id, e.boq_id, e.boq_no, e.revision, e.subject, e.to_addrs, e.status, e.last_error, e.queued_at, e.sent_at, u.full_name, 'boq' AS kind
             FROM boq_emails e LEFT JOIN app_users u ON u.id = e.sent_by
             UNION ALL
             SELECT m.id, NULL::uuid, NULL::text, NULL::int, m.subject, m.to_addrs, m.status, m.last_error, m.queued_at, m.sent_at, u.full_name, 'mail'
             FROM mail_messages m LEFT JOIN app_users u ON u.id = m.sent_by
           ) x ORDER BY coalesce(x.sent_at, x.queued_at) DESC LIMIT 50`),
    query(`SELECT (SELECT count(*) FROM boq_emails WHERE status = 'queued') + (SELECT count(*) FROM mail_messages WHERE status = 'queued') AS queued,
                  (SELECT count(*) FROM boq_emails WHERE status = 'sending') + (SELECT count(*) FROM mail_messages WHERE status = 'sending') AS sending`),
    query(`SELECT state, last_seen_at, extract(epoch from (now() - last_seen_at))::int AS age_seconds FROM worker_status WHERE id = 1`),
  ]);
  const w = worker.rows[0] as { state: string; last_seen_at: Date; age_seconds: number } | undefined;
  const workerOk = !!w && w.state === 'running' && w.age_seconds < 120;
  const s = settings.rows[0];
  const q = queue.rows[0];

  return (
    <main className="wrap page">
      <div className="pagehead">
        <div>
          <h1>Company Gmail</h1>
          <p>Set up once by the admin. Employees send through it but never see the mailbox or its password.</p>
        </div>
      </div>

      {sp.error && <p className="alert err" role="alert">{ERRORS[sp.error] ?? `Connection failed (${sp.error}).`}{sp.got ? ` Signed in as ${sp.got}.` : ''}</p>}
      {sp.connected && <p className="alert ok" role="status">Gmail connected. Sending is on.</p>}
      {s.company_name.startsWith('Your company name') && (
        <p className="alert warn" role="status">
          <span>The “From” name on e-mails still reads <b>{s.company_name}</b>. Set the real name on <Link href="/admin/settings">Settings</Link>, or type a sender name in the template below.</span>
        </p>
      )}

      <div className="grid-2">
        <section className="card stack">
          <div className="card-head">
            <h2 style={{ margin: 0 }}>Connection</h2>
            <span className={`chip ${mail.connected ? 'accepted' : mail.status ? 'rejected' : 'draft'}`}>
              {mail.connected ? 'Connected' : mail.status ? 'Disconnected' : 'Not connected'}
            </span>
          </div>
          {mail.connected ? (<>
            <div className="kv"><span className="hint">Mailbox</span><b>{mail.email}</b></div>
            <div className="kv"><span className="hint">Connected</span><b>{mail.connectedAt ? fmtDateTime(mail.connectedAt) : '—'}{mail.connectedBy ? ` by ${mail.connectedBy}` : ''}</b></div>
          </>) : mail.status === 'revoked' || mail.status === 'error' ? (
            <div className="alert err" style={{ flexDirection: 'column' }}>
              <b>Disconnected: sending is paused{q.queued ? ` (${q.queued} waiting)` : ''}.</b>
              <span>{mail.detail}</span>
            </div>
          ) : (
            <p className="hint">Not connected yet. Save the Google client below, then press Connect and sign in as the company Gmail.</p>
          )}
          <div className="formactions" style={{ justifyContent: 'flex-start' }}>
            {mail.configured ? (
              <form action="/api/integrations/gmail/connect" method="post">
                <button className="btn primary" type="submit">{mail.connected ? 'Reconnect' : 'Connect Gmail'}</button>
              </form>
            ) : (
              <button className="btn primary" type="button" disabled>Connect Gmail</button>
            )}
            {mail.email && <DisconnectButton />}
          </div>
          <div className="kv"><span className="hint">Replies last checked</span><b>{mail.lastSyncAt ? fmtDateTime(mail.lastSyncAt) : 'Not yet'}</b></div>
          <div className="kv"><span className="hint">Instant push</span><b>{process.env.GMAIL_PUBSUB_TOPIC ? 'On (Pub/Sub)' : `Off: checked every ${Number(process.env.REPLY_POLL_SECONDS) || 90} s`}</b></div>
          <div className="kv"><span className="hint">Recipients today</span><b>{daily.used} of {daily.limit}</b></div>
          <div className="kv"><span className="hint">Waiting / sending now</span><b>{q.queued} / {q.sending}</b></div>
          <div className="kv"><span className="hint">Worker</span>
            <b style={{ color: workerOk ? 'var(--ok)' : 'var(--danger)' }}>
              {workerOk ? `Running · checked in ${w!.age_seconds}s ago` : w ? `NOT RUNNING (last seen ${fmtDateTime(w.last_seen_at)})` : 'never started'}
            </b>
          </div>
          {!workerOk && <p className="hint">Start it with <code>npm run worker</code>. Without it, mail stays in <b>Waiting</b> and replies are not read. Health check: <code>/api/health</code>.</p>}
        </section>

        <SettingsForm config={config} />
      </div>

      <div className="grid-2">
        <TemplateForm fromName={s.email_from_name ?? ''} companyName={s.company_name} subject={s.email_subject_template} body={s.email_body_template} />

        <details className="card stack" open={!mail.configured}>
          <summary style={{ cursor: 'pointer', fontFamily: 'var(--f-display)', fontSize: 19, fontWeight: 700 }}>One-time Google Cloud setup</summary>
          <ol style={{ margin: '10px 0 0', paddingLeft: 20, lineHeight: 1.7 }}>
            <li>Sign in to <b>console.cloud.google.com</b> with the company Gmail and create a project (e.g. “HVAC BOQ”).</li>
            <li>APIs &amp; Services → Library → enable <b>Gmail API</b>.</li>
            <li>OAuth consent screen → External → app name, support e-mail; add scopes <code>gmail.send</code> and <code>gmail.readonly</code>; add the company Gmail as a test user. Then <b>Publish app</b> (in Testing mode Google ends the access after 7 days).</li>
            <li>Credentials → Create credentials → OAuth client ID → <b>Web application</b>. Authorised redirect URI: <code>{config.redirectUri}</code></li>
            <li>Paste the client ID, the secret and the mailbox into the form above and press Save. No restart is needed.</li>
          </ol>
          <p className="hint" style={{ margin: 0 }}>Every screen and error message is explained in <code>docs/GMAIL_SETUP.md</code>.</p>
        </details>
      </div>

      <section className="stack">
        <h2 className="section-title">Sent log</h2>
        <div className="scroller">
          <table className="list">
            <thead><tr><th>BOQ</th><th>To</th><th>By</th><th>Status</th><th className="n">Time</th></tr></thead>
            <tbody>
              {sends.rows.length === 0 && <tr><td colSpan={5} className="empty-state">Nothing sent yet.</td></tr>}
              {sends.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.boq_id
                      ? <Link className="title mono" href={`/boqs/${r.boq_id}`}>{r.boq_no} R{r.revision}</Link>
                      : <><span className="chip draft">Official</span><span className="sub">{r.subject}</span></>}
                  </td>
                  <td>{r.to_addrs.join(', ')}</td>
                  <td>{r.full_name ?? '—'}</td>
                  <td><span className={`chip ${chipOf(EMAIL_STATUS, r.status)}`}>{labelOf(EMAIL_STATUS, r.status)}</span>
                    {r.last_error && r.status !== 'sent' && <span className="sub">{r.last_error}</span>}</td>
                  <td className="n">{fmtDateTime(r.sent_at ?? r.queued_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
