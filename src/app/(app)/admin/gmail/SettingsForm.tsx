'use client';

import { useActionState } from 'react';
import { PasswordInput } from '@/components/ui/PasswordInput';
import type { MailConfigView } from '@/lib/mail/config-core';
import { saveGmailSettings, type CfgState } from './actions';

const SOURCE = {
  database: 'Using the settings saved here.',
  env: 'Using the values from .env.local. Saving here overrides them.',
  none: 'Not configured yet — paste the Google client ID and secret to start.',
} as const;

export function SettingsForm({ config }: { config: MailConfigView }) {
  const [state, action, pending] = useActionState<CfgState, FormData>(saveGmailSettings, {});
  return (
    <form action={action} className="card stack">
      <div className="card-head">
        <h2 style={{ margin: 0 }}>Google OAuth client</h2>
        <span className={`chip ${config.source === 'none' ? 'off' : config.source === 'database' ? 'accepted' : 'sent'}`}>
          {config.source === 'database' ? 'Saved in app' : config.source === 'env' ? '.env.local' : 'Missing'}
        </span>
      </div>
      <p className="hint">{SOURCE[config.source]}</p>

      <label className="f"><span className="lbl">Client ID</span>
        <input name="clientId" defaultValue={config.clientId} placeholder="1234567890-abc.apps.googleusercontent.com" autoComplete="off" spellCheck={false} /></label>
      <label className="f"><span className="lbl">Client secret</span>
        <PasswordInput name="clientSecret" placeholder={config.hasSecret ? '•••••• saved — leave blank to keep it' : 'GOCSPX-…'} autoComplete="new-password" /></label>
      <label className="f"><span className="lbl">Company Gmail <small>the app refuses any other account</small></span>
        <input name="mailbox" type="email" defaultValue={config.mailbox} placeholder="company@gmail.com" autoComplete="off" /></label>
      <label className="f"><span className="lbl">Redirect URI <small>must match Google Cloud exactly</small></span>
        <input name="redirectUri" defaultValue={config.redirectUri} className="mono" autoComplete="off" spellCheck={false} /></label>

      {state.error && <p className="ferr" role="alert">{state.error}</p>}
      {state.ok && <p className="fok" role="status">{state.ok}</p>}

      <div className="formactions">
        {config.source === 'database' && (
          <button className="btn reset" name="intent" value="clear" formNoValidate disabled={pending}>
            Remove saved settings
          </button>
        )}
        <button className="btn primary" name="intent" value="save" disabled={pending}>
          {pending ? 'Saving…' : 'Save settings'}
        </button>
      </div>
      <p className="hint">
        The secret is encrypted with <code>GMAIL_TOKEN_KEY</code> before it is stored, is never shown again and never
        appears in the audit log.
      </p>
    </form>
  );
}
