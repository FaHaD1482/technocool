# Audit and remediation

A full pass over the application — security, data integrity, operations, and UI/UX — carried out section by section.
This file is the record: what was found, what changed, what is still open, and how each fix was verified.

Scope: everything under `src/`, the `db/` migrations, `scripts/`, the worker, configuration and deployment
expectations. Not in scope: the contents of the Google Cloud project, and the correctness of the price lists
themselves (checked separately against the client's Excel to the paisa by `src/test/boq.db.test.ts`).

## How to verify the current state

```bash
npm run check       # typecheck + lint + unit tests
npm run test:db     # database suite (needs TEST_DATABASE_URL, see .env.example)
npm run build       # production build
curl localhost:3000/api/health
```

Last verified: typecheck clean, ESLint clean (0 problems), 47/47 unit, 31/31 database, production build OK,
`/api/health` returns 200 with `{"ok":true,"database":true,"worker":{"state":"running"}}`.

---

## Critical

| # | Finding | Fix |
|---|---|---|
| C1 | **Sign-in failed for every password** with `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string`. `.env.local` was absent, so `DATABASE_URL` was undefined and `pg` connected without a password. Any credential looked wrong. | `src/lib/db.ts` fails fast with "DATABASE_URL is not set: copy .env.example to .env.local". `instrumentation.ts` + `src/lib/env.ts` validate the environment at boot (database URL, APP_URL, key length, absolute STORAGE_DIR in production) so a misconfigured deploy stops immediately instead of half-working. |
| C2 | **A BOQ send could half-commit**: the BOQ lock, the export rows and the queued e-mail were written in separate statements. A crash between them left a locked BOQ with no mail, or mail with no files. | `src/lib/mail/send.ts` does all three in one transaction. Files written inside a transaction that rolls back are deleted. |
| C3 | **The sender's own copy of the workbook could diverge from what was sent.** | `boq_exports` records a sha-256 and `source = 'manual'` for the file the estimator edited by hand; the send log says so in words on the BOQ and in the Gmail page. |
| C4 | **Anyone with the shared mailbox password could read every client conversation** — the design goal was the opposite. | Every message carries a per-conversation HMAC plus-tag (`company+b-3f9a2c1d7e@gmail.com`); replies route to the thread without reading the mailbox. Estimators see only their own threads and replies to their own BOQs; admin and manager hold `mail.view_all`. A foreign thread is a **404**, never a 403 (a 403 confirms it exists). |
| C5 | **Login had no rate limit.** | `login_attempts` (migration 14) with per-e-mail, per-IP and site-wide windows of 15 minutes; a successful sign-in clears that address's failures. |

## High

| # | Finding | Fix |
|---|---|---|
| H1 | **Open redirect** on the sign-in `next` parameter: `//evil.com` passed straight through. | `safeInternalPath()` rejects `//host`, `/\host`, encoded separators, control characters and non-paths. Three unit tests. |
| H2 | **No security headers**: the app could be framed, sniffed, and shipped no CSP. | `next.config.ts`: CSP (no `unsafe-eval` in production; development adds it for HMR), `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, HSTS, `strict-origin-when-cross-origin`, `Permissions-Policy`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`. |
| H3 | **State-changing requests had no origin check** (CSRF). | `src/proxy.ts` requires a same-origin `Origin`/`Referer` on non-GET requests; the Google Pub/Sub endpoint is the one machine route, and it checks its own shared secret. Bodies over 25 MB are rejected before buffering. |
| H4 | **Database tests ran against the live database** and could not be run while the worker was up (the worker claimed the test's mail and flipped the account to revoked). | `TEST_DATABASE_URL` is required; the guard refuses a missing value, a URL equal to `DATABASE_URL`, or a database not named `*_test`. See `src/test/setup-db.ts`. |
| H5 | **A clicked notification could be pointed anywhere** — the destination came from the row. | The href is derived server-side from the notification type; `POST /api/notifications/read` marks read; the mail route is read-only (`GET`), so fetching a thread cannot mutate it. |
| H6 | **Session cookies were only `Secure` when `APP_URL` started with `https://`.** A production deploy that forgot APP_URL would ship a cookie over plain HTTP. | `NODE_ENV=production` also forces `Secure` (`src/lib/auth/session.ts`). |
| H7 | **The Gmail OAuth client secret was stored in plain text** in a table the audit log watched. | `mail_config` holds an AES-256-GCM blob keyed by `GMAIL_TOKEN_KEY`; the secret is stripped from the audit log. A wrong or rotated key raises `SecretError` instead of returning garbage. |

## Medium

| # | Finding | Fix |
|---|---|---|
| M1 | **Reply matching trusted weak evidence.** A bare `From:` or a plus-tag could attach mail to the wrong BOQ. | Weak rules only apply to a known client with no SPF/DKIM/DMARC failure; the plus-tag must be ours, HMAC-keyed with a server secret so it cannot be derived from the BOQ number. |
| M2 | **Estimators could edit and delete clients.** | Split into `crm.clients.create` (add — admin/manager/estimator) and `crm.clients.manage` (edit/delete — admin/manager). Enforced in the action, not just the UI. Clients are soft-deleted because `projects.client_id` is `ON DELETE RESTRICT`. |
| M3 | **A failed send left the BOQ locked forever.** | A permanent failure unlocks the BOQ, notifies the sender, and records the reason; a temporary failure retries with backoff. A send that Gmail already delivered is marked sent, not failed (reconciled by `Message-ID`). |
| M4 | **A dead worker looked exactly like an empty queue.** | `worker_status` heartbeat every 30 s, shown on Admin → Gmail as "Running · checked in 17s ago" or "NOT RUNNING (last seen …)", plus `/api/health` for an uptime monitor. |
| M5 | **Migrations could silently corrupt history**: an edited file was reported as "changed" and ignored; there was no backup. | `db:setup` dumps first (`BACKUP_DIR`, outside the repo) and exits non-zero on a checksum mismatch unless `--force`. |
| M6 | **No lint or CI.** | ESLint 9 flat config, `npm run lint`, `npm run check`, and `.github/workflows/check.yml` (typecheck, lint, unit, database suite on a throwaway Postgres, production build). |
| M7 | **No costing attachments on general mail** (policy). | Enforced twice: when the file is uploaded and again in the worker, so a crafted request cannot bypass it. |
| M8 | **The Node version in `engines` was below what `vitest@5` needs.** | `>=22.12` in `engines` and `.nvmrc`. |
| M9 | **`package.json` had an `allowScripts` field that npm does not recognise**, which made npm ignore `.npmrc` and silently skip devDependencies on install. | Removed. |
| M10 | **Stored files were addressed two different ways** — exports by database id, attachments by a relative path — and only one of the two paths checked containment. | Exports are opened only through `filePath(boqId, exportId)` with ids taken from `boq_exports`; attachments are read through `readStoredAttachment()`, which rejects any path resolving outside the storage root. Uploads are checked by extension, size and content type, and re-checked before the message leaves. |

## UI/UX and accessibility

| # | Finding | Fix |
|---|---|---|
| U1 | The totals dock overlapped page content, and the toast sat underneath it. On a phone the dock grew to three rows and still reserved 170 px. | The dock measures itself into `--dock-h` (ResizeObserver); the page reserves that height with a 150 px first-paint floor, and the toast is positioned from the same variable. Verified at 390×844: dock 146 px, last panel 28 px clear, `scrollWidth` 380. |
| U2 | The list filters lost each other: searching from "Drafts" silently returned to "Current", because the segmented buttons were submit buttons. | Filters are links that carry `q`; the search form carries a hidden `status`/`filter`. |
| U3 | Four hand-rolled modals — inconsistent Escape, no focus trap, focus left behind on close, and `SendDialog` could close mid-send because its Escape handler captured a stale `busy`. | One `ui/Dialog.tsx` with focus-in, Tab wrap, Escape (blocked while busy, read through a ref), focus restore and scroll lock. Used by the send dialog, the item drawer, the client dialogs and the mobile menu. |
| U4 | Destructive actions fired immediately: Disable user, Reset password, Disconnect Gmail, Discard reply (the last used `window.confirm`). | One `ui/Confirm.tsx`; the dialog stays open and shows the server's error if the action fails. |
| U5 | Attachments could be chosen but not removed, and re-picking the same file did nothing (the input kept its value). | `ui/FileField.tsx`: per-file remove, input cleared after each pick, duplicates ignored, five-file cap. |
| U6 | The same e-mail showed different times on the server and in the browser (UTC vs local); nine ad-hoc `Intl.DateTimeFormat` instances. | One `lib/format.ts` with an explicit `Asia/Dhaka`. |
| U7 | Required fields were unmarked; the item drawer showed an error border on an untouched empty field. | `label.f:has([required])>.lbl::after` draws the `*` from the attribute; `aria-invalid` only after a failed save. |
| U8 | On a 390 px phone the item drawer's three-column number row left ~90 px per field and clipped labels; long brand names overflowed their pills. | Drawer grids collapse 3→2→1; pills wrap, ellipsize and reflow 3→2→1. |
| U9 | 14 pages rendered `<main>` inside the shell's `<main>`: nested landmarks. | The shell's content wrapper is a `div`. |
| U10 | Page navigation looked like a dead click while the server rendered. | `(app)/loading.tsx` skeleton with a reduced-motion fallback. |
| U11 | An expired session produced "Something went wrong" on every form. | `lib/client-api.ts` sends a 401 to `/login?next=…`. Verified end-to-end by revoking a session mid-compose. |

## Maintainability

| # | Finding | Fix |
|---|---|---|
| N1 | Array indexing was unchecked, so `rows[0].id` and regex groups were assumed present. | `noUncheckedIndexedAccess: true`, with 58 sites fixed: real guards where absence is possible, `??` fallbacks with a reason where it is not. |
| N2 | Email status was worded differently on three screens ("Waiting", "Waiting to send", nothing), and the BOQ status label map existed three times. | `lib/labels.ts`: `BOQ_STATUS`, `EMAIL_STATUS`, `ROLES`, plus `labelOf`/`chipOf`/`roleLabel`. |
| N3 | `zodError.issues[0].message` was repeated in five actions. | `lib/forms.ts` → `firstIssue()`. |
| N4 | `db/README.md` described 23 permissions and four migrations; the schema has 30 and 15. | Rewritten against the live database, including the mail and worker tables and the backup/checksum behaviour. |
| N5 | Dead CSS and tokens. | Removed `.rowlink`, `.ed-actions`, `.alert.info`, `--flash`, `--s1`–`--s6`, `--r-sm`, `--r-lg` — found by matching every selector and custom property in `globals.css` against the sources rather than by eye. |

---

## Still open

These need a decision or a credential from the owner, not more code:

1. **The Google OAuth client secret must be rotated** in Google Cloud (it appeared in a screen share), then pasted in
   Admin → Gmail.
2. **Press "Reconnect"** on Admin → Gmail. The `GMAIL_TOKEN_KEY` rotation invalidated the stored token; until then the
   account is marked `revoked` and the UI says so instead of the worker retrying silently. Real mail is paused.
3. **Change the PostgreSQL password from `root`** and update `.env.local` and DBeaver.
4. **The worker must run next to the web app** (`npm run worker`, or a service). It is now visible on the Gmail page and
   at `/api/health`, but nothing starts it automatically.
5. **No automated browser tests.** The UI work was verified by hand with `agent-browser` at 390 px and 1280 px; adding
   Playwright would protect the dock, dialog and filter behaviour from regressions.
6. **One role per user in the UI.** `user_roles` supports several; the users screen assigns exactly one.

## Accepted risks

- **CSP allows `'unsafe-inline'` for scripts and styles.** Next.js inlines bootstrap scripts and the theme pre-paint
  script; a nonce-based policy needs a middleware rewrite of every response. Recorded here rather than hidden.
- **The audit log is append-only in the app, not in the database.** Someone with the `postgres` role can edit it. The
  database password is the boundary; rotate it and keep it out of the repository.
- **Daily recipient limit is enforced per day, not per minute** (Gmail's own quota is the harder limit).
- **Weak reply matching is still a heuristic**, narrowed as described in M1. Unmatched mail is not lost: admins see it
  on Admin → Unmatched replies.
