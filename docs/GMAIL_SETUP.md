# Connecting the company Gmail — step by step

This connects the company (boss) Gmail to the BOQ system **once**, so that:

- employees press **Send BOQ** in the app and the mail leaves from the company Gmail, and
- the client's **reply comes back into the right BOQ** automatically.

No employee ever gets the Gmail password. The app never sees it either: Google gives the app a *permission token*
that the boss can cancel at any time, and the app stores that token encrypted.

**Time:** about 30–45 minutes. **Who:** step 1 the boss; steps 2–6 the boss or a trusted admin signed in **as the
company Gmail**; step 7 the app admin (no server access needed); steps 8–10 the app admin, with the boss nearby to sign in.

> Do the steps **in order**, in one sitting if you can. Step 5 is the one people skip — without it the connection
> dies every 7 days.

---

## Fill this in as you go

You will collect four values. Write them here before you start the app part:

| Value | Where it comes from | Yours |
|---|---|---|
| Company Gmail address | The boss | |
| Client ID | Step 6 | |
| Client secret | Step 6 | |
| Redirect URI | Step 6 (and step 7) | |

Checklist:

- [ ] 1. Company Gmail secured (2-step verification on, password changed)
- [ ] 2. Google Cloud project created
- [ ] 3. Gmail API enabled
- [ ] 4. Consent screen filled in (name, audience, test user, two scopes)
- [ ] 5. App **published** — not left in "Testing"
- [ ] 6. OAuth client created, client ID + secret copied
- [ ] 7. Client ID, secret and mailbox saved on the app's Gmail page
- [ ] 8. Gmail connected inside the app
- [ ] 9. Test BOQ sent to yourself
- [ ] 10. Test reply landed on the BOQ

---

## "Can I do this while the app still runs on localhost?"

**Yes.** Every step below works with the app on `http://localhost:3000`. Nothing here needs a live website, a
domain, a public IP or an SSL certificate.

- **Publishing (step 5) is about the consent screen, not your server.** "In production" means Google stops cancelling
  the token every 7 days. Google never checks that your app's URL resolves or is reachable when you publish.
- **Google accepts `http://localhost` redirect URIs** (that is the one exception to its HTTPS rule), so the redirect
  URI in step 6 is simply `http://localhost:3000/api/integrations/gmail/callback`.
- **Sign in on the same machine and browser** that runs the app, and finish within 10 minutes: the flow is held in a
  cookie by the app itself (PKCE + state).
- **Sending and reading mail work from your own PC** — the app makes only outbound calls to Gmail. The worker can run in
  a second terminal next to `npm run dev`.
- **The one thing that needs a public address is the optional Pub/Sub push** in the appendix. Skip it; replies arrive
  every ~90 seconds through polling instead.
- **When you later deploy**, add the production redirect URI to the *same* OAuth client (step 6), set `APP_URL` to the
  real `https://` address in `.env.local`, save the matching redirect URI on the app's Gmail page and press
  **Reconnect**. The company Gmail, client ID and secret stay the same.

---

## Step 1 — Secure the company Gmail

Do this first; everything else depends on this account being safe.

1. Sign in at <https://myaccount.google.com> as the company Gmail.
2. **Security → How you sign in to Google → 2-Step Verification** → turn it on (Authenticator app or phone prompt).
3. **Security → Password** → change it. If the old password was ever shared in a chat, treat it as known.
4. **Security → Recovery** → make sure the recovery phone and e-mail belong to the boss.
5. Optional: **Security → Your connections to third-party apps & services** → remove anything you do not recognise.

> Changing the password *after* the app is connected can disconnect it (Google cancels the token). The admin then sees
> a red **Gmail is disconnected** banner and just presses **Reconnect**. Mail waiting in the queue goes out by itself.

---

## Step 2 — Create a Google Cloud project

1. Open <https://console.cloud.google.com>. Check the account picture at the top right: you must be signed in **as the
   company Gmail**, not a personal account.
2. Accept the terms if asked. **No billing account is needed** for this.
3. Top bar → **project picker** (next to "Google Cloud") → **New project**.
   - Project name: `HVAC BOQ`
   - Organization / Location: **No organization**
4. **Create**, wait a few seconds, then select the new project in the project picker.

---

## Step 3 — Enable the Gmail API

1. Menu (☰) → **APIs & Services → Library**.
2. Search **Gmail API** → open it → **Enable**.

---

## Step 4 — Set up the consent screen

This is the screen the boss sees when connecting. Google now calls it **Google Auth Platform**; older screens call it
**OAuth consent screen**.

1. Menu (☰) → **APIs & Services → OAuth consent screen** (or **Google Auth Platform**). If there is a **Get started**
   button, press it.
2. **Branding / App information**
   - App name: `HVAC BOQ System`
   - User support e-mail: the company Gmail
   - Logo, home page, privacy policy: leave **empty** (a logo triggers a slow Google review).
3. **Audience:** **External** — this is required for an ordinary `@gmail.com` account.
4. **Contact information:** the company Gmail. Agree to the policy → **Create**.
5. **Audience → Test users → Add users**: add the **company Gmail address** → Save.
6. **Data Access** (older: **Scopes**) → **Add or remove scopes** → add exactly these two:

   | Scope | Why the app needs it |
   |---|---|
   | `https://www.googleapis.com/auth/gmail.send` | Send BOQ e-mails from the company Gmail |
   | `https://www.googleapis.com/auth/gmail.readonly` | Read reply headers so a reply reaches the right BOQ, and read the real Message-ID of sent mail |

   → **Update** → **Save**. Google labels `gmail.readonly` a *restricted* scope; that is expected and step 5 explains
   what it means.

   > The app never deletes, moves or labels mail — it only asks for *send* and *read*.

---

## Step 5 — Publish the app (do not skip)

While the status is **Testing**, Google **cancels the connection every 7 days** and sending stops until someone presses
Reconnect.

1. **Audience** → **Publishing status: Testing** → **Publish app** → **Confirm**.
2. The status becomes **In production**. Google may show **Needs verification** — that is fine, you do **not** submit
   for verification. Only the company Gmail ever signs in, far below Google's limit of 100 users for unverified apps.
3. Because the app is unverified, Google shows **"Google hasn't verified this app"** during step 8. That is normal for a
   private app: **Advanced → Go to HVAC BOQ System (unsafe)**.

> **If Google refuses to publish or blocks the sign-in** (its rules for restricted scopes change), you have two choices:
> stay in **Testing** and press **Reconnect** once a week, or submit the app for verification (weeks, possibly a security
> assessment). Tell whoever maintains the server which one you chose.

---

## Step 6 — Create the OAuth client

1. **Clients** (older: **APIs & Services → Credentials → Create credentials → OAuth client ID**) → **Create client**.
2. Application type: **Web application**. Name: `HVAC BOQ web`.
3. **Authorised redirect URIs → Add URI.** It must match the app's address **exactly** — same `http`/`https`, same
   host, same port, **no trailing slash**.

   | Where the app runs | Redirect URI |
   |---|---|
   | This PC (development) | `http://localhost:3000/api/integrations/gmail/callback` |
   | Live server (example) | `https://boq.yourcompany.com/api/integrations/gmail/callback` |

   You can add both now. Leave **Authorised JavaScript origins** empty.
4. **Create**. Copy the **Client ID** and **Client secret** (there is also **Download JSON**). Treat the secret like a
   password.

> If the secret leaks (sent in a chat, committed to Git), open the client in Google Cloud, **add a new secret**, paste it
> into the app's Gmail page (step 7), then **delete the old secret**.

---

## Step 7 — Enter the settings in the app

You do **not** edit `.env.local` for this any more. The admin enters the values on the **Gmail** page; the app encrypts
the secret and the worker picks it up within a few seconds — no restart.

1. Sign in as an **administrator** → **Gmail**.
2. In the **Google OAuth client** card fill in:
   - **Client ID** — from step 6
   - **Client secret** — from step 6 (it is stored encrypted and never shown again; leaving it blank keeps the saved one)
   - **Company Gmail** — the exact mailbox from step 1
   - **Redirect URI** — pre-filled with `<APP_URL>/api/integrations/gmail/callback`. It must be identical to the one you
     added in step 6.
3. Press **Save settings**. The chip changes to **Saved in app**.

The only setting that still lives in `.env.local` is `GMAIL_TOKEN_KEY` (the encryption key, which must never be stored
with the data). Keep a copy in a password manager:

```ini
# already there; do not change it once Gmail is connected
GMAIL_TOKEN_KEY=...
# the public address of the app (cookies, CSRF check, redirect default)
APP_URL=http://localhost:3000
```

Notes:

- **`GMAIL_TOKEN_KEY`** encrypts both the refresh token and the client secret. If it is lost or changed, the stored
  secrets become unreadable — paste the client secret again and press **Reconnect**.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` / `GMAIL_ADDRESS` in `.env.local` are still read as
  a **fallback** when nothing is saved in the app. That is how existing installs keep working.
- On the live server, `APP_URL` (and the redirect URI you save) use the real `https://` address.
- Optional: `MAIL_DAILY_RECIPIENT_LIMIT=450` (free Gmail allows ~500 recipients a day; Send is blocked at this number)
  and `REPLY_POLL_SECONDS=90` (how often replies are checked). These stay in `.env.local`.

If you changed `.env.local` anyway, restart both processes:

```bash
# terminal 1 — the web app (Ctrl+C the old one first)
npm run dev            # or on the server: npm run build && npm start

# terminal 2 — the worker that sends mail and reads replies; it must keep running
npm run worker
```

The worker prints `worker started`. It only warns "Google OAuth is not configured yet" when neither the app nor
`.env.local` has a client ID.

---

## Step 8 — Connect Gmail inside the app

1. Sign in as an **administrator** → **Gmail** in the main menu.
   If the Connect button is disabled, step 7 is not saved yet (the card shows **Missing**).
2. Press **Connect Gmail**. Google opens.
3. Sign in **as the company Gmail** (the boss enters the password and approves the 2-step prompt).
4. **"Google hasn't verified this app"** → **Advanced** → **Go to HVAC BOQ System (unsafe)**.
5. On the permission screen **tick both boxes** — *Send email on your behalf* and *View your email messages and
   settings* — then **Continue**.
6. You come back to the app with **"Gmail connected. Sending is on."** The Connection box shows the mailbox and
   **Connected**.

Within about 90 seconds **Replies last checked** shows a time — that means the worker can read the inbox.

---

## Step 9 — Send a test BOQ

1. Create a **test client** using your own e-mail address.
2. Create a BOQ for it and add a few **priced** items (LG or Daikin; some DB-brand items have no price yet and will
   block sending).
3. **Send BOQ**. The subject must contain a code like `[BOQ-2026-0005 R0]`. Choose BDT / USD / Both → **Send now**.
4. The BOQ page moves from **Waiting to send** to **Sent** within a few seconds. If it stays on *Waiting*, the worker
   is not running.
5. In the inbox, check:
   - From: the company Gmail, with the sender name from the template
   - The Excel file(s) open correctly and contain **no costing sheet**
   - **Reply** shows *To* as `yourcompany+boq-2026-0005-r0@gmail.com`. That is correct: Gmail delivers "plus"
     addresses to the same inbox and the tag tells the app which BOQ the reply belongs to.
6. The company Gmail's **Sent** folder shows the same mail.

The e-mail text is editable on the **Gmail** page → **E-mail template**.

---

## Step 10 — Test a reply

1. Reply to the test mail from your own mailbox, with a short text and a small attachment.
2. Wait up to 90 seconds.
3. The BOQ owner sees a red number on the **bell**; the BOQ page shows **Client replies** with the text and the
   attachment; the BOQ list shows a reply count.
4. Optional: send a **new** mail (not a reply) with the code in the subject, e.g. `Question about BOQ-2026-0005 R0`.
   It also lands on that BOQ.
5. Mail from that client **without** a code, while the client has two open BOQs, goes to **Unmatched** (admin menu)
   where it can be assigned.

**Mail the app never stores:** newsletters, mail from people who are not clients, auto-replies and anything the company
sends itself. It stays in Gmail, untouched.

---

## Everyday rules

- **Keep client replies in the Inbox.** The app reads the INBOX only. A Gmail filter that skips the Inbox (archives)
  or deletes client mail hides those replies. Labels are fine; archiving a few minutes later is fine.
- **The worker must always run** next to the web app. On a live server run it as a service, for example
  `pm2 start "npm run worker" --name boq-worker` then `pm2 save`, or a Windows Task Scheduler task "At startup".
  If it stops, sends wait and replies are back-filled when it restarts (about a week back).
- **Employees can write to clients from the Inbox** without any mailbox access: each conversation gets its own reply
  address (`company+c-…@gmail.com`), the client only ever sees the company address, and replies come back to the
  employee who started the conversation. Same `gmail.send` + `gmail.readonly` scopes — nothing extra to authorise.
- **Sending limit:** free Gmail allows about 500 recipients a day; the Gmail page shows today's count.
- **Never change `GMAIL_TOKEN_KEY`** while Gmail is connected, and keep a copy of it.
- **Only the company Gmail should have access** to the Google Cloud project. Do not add IAM users unless they must
  manage it.

---

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| Gmail page: **Connect Gmail** is disabled, card shows *Missing* | The Google client was not saved | Fill in step 7 and press **Save settings** |
| Google: **Error 400: redirect_uri_mismatch** | The redirect URI saved on the Gmail page is not in the client's list exactly | Make both identical, character for character (same http/https, port, no trailing `/`); wait 1–2 minutes |
| Google: **Error 403: access_denied** — "has not completed the Google verification process" | App still in Testing and the account is not a test user | Add the company Gmail as a test user (step 4.5), or publish (step 5) |
| Google: **This app is blocked** | Google's rules for restricted scopes on unverified apps | See the box in step 5 |
| App: *Access was not allowed on the Google screen* | Cancel was pressed | Connect again and allow |
| App: *Not all access was allowed* | One of the two boxes was unticked | Connect again and tick both |
| App: *Google did not give a lasting token* | Google skipped the refresh token (app was connected before) | <https://myaccount.google.com/connections> → remove *HVAC BOQ System* → Connect again |
| App: *That is not the company Gmail* | A different Google account was picked | Connect again with the company Gmail, or fix `GMAIL_ADDRESS` |
| App: *The sign-in could not be verified* | The Google page was open too long or in another tab/browser | Press Connect again and finish within 10 minutes in the same browser |
| App: *Google refused the sign-in* | Wrong client ID/secret, or the secret was rotated | Recheck step 7, restart both processes |
| Red banner: **Gmail is disconnected** | Password changed, access removed, or 7 days passed in Testing mode | Gmail page → **Reconnect**; waiting mail sends itself afterwards |
| Send stays on **Waiting to send** | Worker not running, or Gmail disconnected | Start `npm run worker`; check the Gmail page |
| **Failed** with a message | Gmail refused that mail (for example a bad address); the BOQ was unlocked again | Read the message on the BOQ page, fix, send again |
| Replies never appear | Worker not running, or a Gmail filter archived them | Check *Replies last checked*; check Gmail filters |
| Reply landed in **Unmatched** | The client wrote a new mail without the code and has several open BOQs | Admin → Unmatched → **Assign** |

---

## Optional — instant replies with Google Pub/Sub

Without this, replies appear within about 90 seconds, which is enough for most offices. Push makes it nearly instant
but needs the app on a **public `https://` address** (it does not work on `localhost`).

1. Google Cloud → **APIs & Services → Library** → enable **Cloud Pub/Sub API**.
2. **Pub/Sub → Topics → Create topic**, ID `gmail-replies`. Note the full name
   `projects/<your-project-id>/topics/gmail-replies`.
3. Open the topic → **Permissions → Add principal** → `gmail-api-push@system.gserviceaccount.com`, role
   **Pub/Sub Publisher** → Save.
4. **Subscriptions → Create subscription** on that topic:
   - Delivery type: **Push**
   - Endpoint URL: `https://<your-app-address>/api/integrations/gmail/push?token=<GMAIL_PUSH_TOKEN>`
     (the token is already in `.env.local`)
   - Leave the rest default → Create.
5. Set `GMAIL_PUBSUB_TOPIC=projects/<your-project-id>/topics/gmail-replies` in `.env.local` and restart the worker.
6. The Gmail page then shows **Instant push: On**. The worker renews the Gmail watch every few days, and the 90-second
   check keeps running as a safety net.

At this volume Pub/Sub stays inside Google's free tier, but Google may ask for a billing account.

---

## Disconnecting or changing the mailbox

- **Disconnect** on the Gmail page removes the token from the app *and* cancels it at Google.
- From Google's side: <https://myaccount.google.com/connections> → *HVAC BOQ System* → *Delete all connections*.
- To move to a different Gmail: disconnect first, change the **Company Gmail** on the Gmail page (step 7), press
  **Connect Gmail** and sign in with the new mailbox. Sent history and replies stay in the database.
