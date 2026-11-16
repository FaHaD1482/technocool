# HVAC BOQ System

One web system where each employee builds their own BOQs, exports editable Excel offers, and (phase 4) sends them
from the boss's Gmail with one click, without anyone but the boss holding Gmail access.
The full plan is in [docs/HVAC BOQ System Plan.md](docs/HVAC%20BOQ%20System%20Plan.md); the original single-file
prototype is in [docs/prototype/](docs/prototype/).

**Stack:** Next.js 16 (App Router, TypeScript) for the screens and API · PostgreSQL 15+ · ExcelJS on the server ·
argon2id passwords · decimal.js for money (never floating point).

## Status by phase

| Phase | What | State |
|---|---|---|
| 1 Foundation | Project, database migrations, login, roles, own-BOQ-only checks, users admin | Done |
| 2 BOQ core | Editor ported from the prototype, saves to the database, shared calculation module, revisions | Done |
| 3 Excel export | Server-side export, BDT / USD / Both, private file storage, export log | Done |
| 4 Gmail send | Admin connects Gmail, send with attachments, subject code + plus tag, sent log | Done (needs a Google Cloud OAuth client to go live) |
| 5 Replies | Thread / header / tag / subject / sender matching, push + polling, Unmatched list, notifications | Done (needs the Gmail connection to go live) |
| 6 Hardening | Rate limits, backups, audit review, load test, admin guide | Partly (login lockout, CSRF, headers) |

## First-time setup (Windows, local)

Needs Node.js 22.12+ and PostgreSQL 15+ running locally.

```bash
npm install --include=dev         # --include=dev matters if your npm config omits devDependencies
copy .env.example .env.local      # then edit: DATABASE_URL, DB_ADMIN_URL, GMAIL_TOKEN_KEY (npm run gen-secret)
npm run db:setup                  # creates the hvac_boq database and applies db/NN_*.sql in order
npm run create-admin -- --email you@company.com --name "Your Name"
npm run dev                       # http://localhost:3000
npm run worker                    # second terminal: sends queued e-mails and reads client replies
```

Starting from existing data? Restore `db file/hvac_boq.sql` instead of `db:setup` — see
[db/README.md](db/README.md#restoring-db-filehvac_boqsql) for the exact commands.

`create-admin` prints a one-time password. Sign in, then change it on **My account**. Add employees on **Users**
(each gets their own one-time password).

### Using DBeaver

You do **not** need to create the database by hand: `npm run db:setup` does it. Use DBeaver to look at the data:

1. In the Database Navigator, right-click your PostgreSQL connection → **Edit Connection**.
2. On the **PostgreSQL** tab tick **Show all databases**, then OK. (Or set *Database* to `hvac_boq` on the Main tab.)
3. Refresh (F5). Open `hvac_boq` → Schemas → `public` → Tables.

Useful tables: `boqs`, `boq_items`, `boq_exports`, `app_users`, `audit_log`, `schema_migrations` (what has run).
Useful views: `v_boq_totals`, `v_boq_item_amounts`.

If you would rather run the SQL in DBeaver yourself: create the database (right-click *Databases* → Create New
Database → `hvac_boq`, encoding UTF8), open each file in `db/` in order with **SQL Editor → Open SQL script**, and run
it with **Execute SQL Script (Alt+X)**, not Ctrl+Enter. Then `npm run db:status` will show them as pending, because
the runner did not record them, so pick one method and stick to it.

## Sending BOQs by Gmail (phase 4)

**Step-by-step setup guide: [docs/GMAIL_SETUP.md](docs/GMAIL_SETUP.md).**

1. **One-time Google setup** (by whoever owns the company Gmail): the steps are on the **Gmail** page in the app
   (create a Google Cloud project, enable the Gmail API, consent screen with `gmail.send` + `gmail.readonly`, **publish**
   the app, create a *Web application* OAuth client with redirect URI `<APP_URL>/api/integrations/gmail/callback`).
   Then the admin pastes the **client ID, client secret and company Gmail** into the **Google OAuth client** card on that
   same page and presses **Save settings** — no `.env.local` edit and no restart (the environment variables are still
   read as a fallback).
2. **Connect**: the admin opens **Gmail → Connect Gmail** and signs in as the company Gmail. Only an encrypted refresh
   token is stored (AES-256-GCM, key in `GMAIL_TOKEN_KEY`); no password, and nobody else ever sees the mailbox.
3. **Send**: in a BOQ, **Send BOQ** opens a dialog (To, Cc, subject, message from the template, BDT / USD / Both).
   It is blocked while any line has a 0 rate, Gmail is not connected, or the daily limit is reached.
   If the estimator edited the workbook in Excel instead, choose **The Excel I edited myself** and upload it there:
   that file is sent as-is (the app records that it was hand-edited, and refuses one that contains the internal
   costing sheet), so the send, the revision lock and the reply tracking still stay in the app.
   On Send the revision is locked (the client-safe files are built from it, or the upload is used) and the worker
   sends the mail with subject code `[BOQ-2026-0012 R1]`, Reply-To `company+boq-2026-0012-r1@gmail.com` and records
   the Gmail message id, thread id and Message-ID (used in phase 5 to route replies).
4. **The worker** (`npm run worker`) must run next to the web app. It retries temporary Gmail errors (after 1, 5,
   15 min), unlocks the BOQ and notifies the sender on a permanent failure, and pauses all sending (banner for the
   admin) if Google revokes access. Once Gmail accepts a mail it is never sent twice.
   `npm run worker -- --once` processes what is due and exits.

## Client replies (phase 5)

- The worker reads new INBOX mail every `REPLY_POLL_SECONDS` (default 90) using the Gmail history, so nothing is
  missed even if it was stopped for a while (after about a week it falls back to the last 3 days of inbox mail).
- **Privacy:** it reads the headers only, then tries, in order: Gmail thread → In-Reply-To/References → plus-address tag
  → BOQ code in the subject → sender (only if that client has exactly one open BOQ). Auto-replies and the company's own
  mail are ignored. The body is downloaded only for a matched reply, or for mail from a known client / with a BOQ code
  (that goes to the admin-only **Unmatched** page). All other inbox mail is never stored. Employees cannot search the inbox.
- A matched reply is saved on the exact revision that was sent, attachments are copied into private storage (up to
  20 MB each, 50 MB per mail), the BOQ owner gets a notification (bell in the top bar) and sees it in the BOQ page.
  Nobody else can, except admins / managers (`boq.view_all`). The BOQ list shows a reply count (red = new).
- **Unmatched:** the admin sees those mails with **Assign** (pick the BOQ; the owner is notified) or **Discard**.
  A reply whose BOQ is ever deleted returns to this list.
- **Instant push (optional, needs public HTTPS):** create a Pub/Sub topic in the same Google Cloud project, give
  `gmail-api-push@system.gserviceaccount.com` the *Pub/Sub Publisher* role on it, add a push subscription to
  `<APP_URL>/api/integrations/gmail/push?token=<GMAIL_PUSH_TOKEN>`, and set `GMAIL_PUBSUB_TOPIC=projects/<id>/topics/<name>`.
  The worker renews the Gmail watch itself. Polling keeps running as the fallback.

## Client mail and the Inbox

Every employee with `mail.send` (admin, manager, estimator) gets an **Inbox** in the main menu:

- **New message** writes to a client from the company Gmail — an official e-mail or a question, with up to 5 office
  attachments (PDF, Word, Excel, CSV, TXT, images, ZIP; 10 MB each, 20 MB total).
- Every conversation has its own reply address (`company+c-1f2e3d4c@gmail.com`), so the client's answer lands in that
  conversation and is notified to its owner. Nobody needs the mailbox password.
- BOQ sends appear in the Inbox too — one conversation per BOQ number — and their replies show in both places.
- A conversation is visible to its owner; admin and manager (`mail.view_all`) see all of them. A foreign conversation
  answers 404, never 403.
- Sending and reading use the same Gmail permissions as BOQ mail, so there is nothing extra to authorise. General mail
  and BOQ mail share the daily recipient limit.
- Mail that matches nothing stays in Gmail; only known-client mail reaches the admin-only **Unmatched** page.

### Sending guarantees

- **Sending is atomic.** The BOQ lock, the `boq_exports` rows and the `boq_emails` queue row commit in one transaction,
  so a crash can never leave a BOQ marked *Sent* with nothing queued. The generated files are removed if it rolls back.
- **An interrupted send is reconciled, not guessed.** If the worker dies mid-send, it asks Gmail (by `Message-ID`)
  whether the mail was already delivered before it reports "check the Sent folder" — the client never gets it twice.
- **Costing never leaves by e-mail.** A workbook containing the internal costing sheet is refused when a general
  message is uploaded, and the worker re-checks every `.xlsx` attachment just before sending.
- **A removed client cannot receive a new offer.** Soft-deleted clients are blocked as recipients and in the composer.
- **A changed key pauses, it does not loop.** If `GMAIL_TOKEN_KEY` no longer decrypts the stored token, sending pauses
  with the "reconnect" banner instead of retrying forever.

## Secrets, dumps and rotation

- Everything secret lives in `.env.local` (git-ignored): the database URL, `GMAIL_TOKEN_KEY` and the Google OAuth
  client. **`GMAIL_TOKEN_KEY` cannot be recovered** — keep a copy in a password manager.
- **Never keep database dumps inside the project.** A dump contains `password_hash`, `refresh_token_enc` and
  `client_secret_enc`; next to `.env.local` it is a complete compromise (read the mailbox and send as the company).
  Write backups somewhere else: `pg_dump -Fc hvac_boq > D:\backups\hvac_boq-<date>.dump`, restore with
  `pg_restore -d hvac_boq <file>`. `db/*.dump` is git-ignored, but the folder is still the wrong place.
- If a dump, `.env.local` or this machine is exposed: rotate `GMAIL_TOKEN_KEY` (the stored Gmail token becomes
  unreadable — paste the Google client secret again and press **Reconnect**), add a new Google OAuth client secret and
  delete the old one, change the database password, and reset the admin passwords.

## Security posture

- **Headers**: a strict CSP (own origin only, no framing, no plugins), HSTS, `nosniff`, `strict-origin-when-cross-origin`,
  COOP and a restrictive `Permissions-Policy`; `x-powered-by` is off. Development adds `eval`/websocket for HMR only.
- **Session cookie**: httpOnly, SameSite=Lax, and `Secure` **whenever `NODE_ENV=production`** (a missing `APP_URL` can no
  longer silently downgrade it). Expired rows are pruned in the background.
- **Login throttling** is in the database (`login_attempts`): per e-mail, per IP and site-wide, all in a 15-minute window.
  It survives a restart and is shared by every instance. Put the app behind a proxy that overwrites
  `X-Forwarded-For`, otherwise the per-IP bucket is client-controlled.
- **Redirects** are same-site only (`safeInternalPath`); notification links are computed on the server from the row,
  never accepted from the browser.
- **Rendering never writes**: opening a BOQ or a conversation marks it read with a `POST`, so a prefetch or a link
  preview cannot clear a badge. `Connect Gmail` is a form POST for the same reason.
- **Uploads** are capped at 25 MB per request at the edge (`proxy.ts`), in addition to the per-file/total limits.
- **Errors** from server actions are mapped to safe text; database messages are logged, never returned.
- **Boot check**: `instrumentation.ts` validates `DATABASE_URL`, `APP_URL`, the key length and (in production) an
  absolute `STORAGE_DIR`, so a misconfigured deployment fails at start instead of half-working.

## Running and monitoring

- **Two processes**: `npm start` (web) and `npm run worker` (mail). The worker writes a heartbeat every 30 s; the Gmail
  page shows **Worker: Running / NOT RUNNING** and `/api/health` answers 200/503 for an uptime monitor
  (`{"ok", "database", "worker": {"state", "ageSeconds"}}`).
- **Migrations** (`npm run db:setup`) take a `pg_dump` into `BACKUP_DIR` (default `../technocool-backups`) first, and
  **fail** if an already-applied file was edited — use `--force` deliberately, `--no-backup` for a throwaway database.
- **Database tests** need `TEST_DATABASE_URL` pointing at a `*_test` database; the suite refuses to run against
  `DATABASE_URL`. Create it once with
  `createdb hvac_boq_test && DATABASE_URL=<test url> npm run db:setup:test`.
- **CI** (`.github/workflows/check.yml`) runs typecheck, lint, unit tests, the DB suite against a temporary
  database, and a production build on Node 22 (`engines` and `.nvmrc` are pinned to 22.12+).
- `npm run check` runs typecheck + lint + unit tests locally.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Development server with hot reload |
| `npm run build && npm start` | Production build and server |
| `npm test` | Unit tests: calculation, amounts in words, reply matching |
| `npm run test:db` | Integration tests against the database in `.env.local`: calculation vs SQL views to the paisa, own-BOQ rule, locking, revisions, Excel files. They create and delete their own rows but use up BOQ numbers, so point `.env.local` at a test database before running them on real data. |
| `npm run typecheck` | TypeScript check |
| `npm run db:setup` / `db:status` | Apply / list database migrations |
| `npm run create-admin` | Create an admin, or reset one's password |
| `npm run worker` | Background sender (keep running; `-- --once` to run once) |

## How the code is laid out

```
db/                    01-03 original schema and seed, 04 ownership + mail tables + new permissions
scripts/               db-setup (migration runner), create-admin
src/proxy.ts           sign-in redirect + CSRF origin check (Next 16's name for middleware)
src/lib/calc/          THE calculation module (decimal) + amounts in words; used by screen, Excel and API
src/lib/boq/           types, row helpers (shared), repo.ts (server: load, save, revisions, own-BOQ rule)
src/lib/excel/         workbook builder (port of the prototype) and export storage
src/lib/auth/          sessions, passwords, permissions
src/lib/mail/          Gmail OAuth + REST client, token encryption, MIME, templates, send queue, reply matching
src/worker/            background worker: process.ts sends queued mail, replies.ts reads and routes replies
src/lib/replies.ts     replies per BOQ (own-BOQ rule), notifications, Unmatched assign / discard, reply files
src/app/               pages: login, BOQ list, new BOQ, BOQ editor, clients, users, account; API routes
src/components/editor/ the BOQ editor (equipment, local items, offer summary, dock, edit drawer)
```

## Rules the code follows

- **Own BOQs only.** Every BOQ query filters on `owner_user_id` unless the user has `boq.view_all` (admin, manager).
  Another person's BOQ answers 404, so its existence is not revealed.
- **Costs stay hidden** from users without `boq.costing.view`: the server replaces cost with the selling rate before
  anything reaches the browser, and the costing sheet is only built on request by someone allowed to see it.
  `assertClientSafe()` refuses any client-bound file with a costing sheet.
- **Same numbers everywhere.** `src/lib/calc` uses decimal maths with the same rounding as the SQL views;
  `npm run test:db` proves they agree to the paisa.
- **Sent means locked.** Database triggers refuse changes to a non-draft BOQ; use *Create revision*.
- **Audit.** Each write runs in a transaction with `app.user_id` set, so `audit_log` records who did it.
  Logins, failed logins and exports are logged too.
- **Sessions** are random tokens in an httpOnly cookie; the database keeps only their SHA-256. They end after 12 hours
  idle or 7 days. 5 wrong passwords lock the account for 15 minutes.
