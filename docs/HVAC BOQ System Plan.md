# HVAC BOQ System Plan

Nov 5, 2026 · @Fahad

One web system where each employee builds their own BOQs and sends them from the boss's single Gmail with one click, with no one but the boss ever holding Gmail access.

## Goals and decisions made

The system must let about 10-15 employees create BOQs, send them to about 10-20 clients from one company Gmail, and see only their own clients' replies. The boss keeps the only Gmail login.

| Topic | Decision |
| --- | --- |
| Boss mailbox | Free @gmail.com account, connected once with Google OAuth. No password is ever typed into or stored by the system. |
| Who sees what | Employees see only their own BOQs, clients' replies and notifications. Admin and boss see all. |
| Approval | None. The employee clicks Send and the email goes out directly. |
| Attachment | Editable Excel only. Before sending, the employee picks USD, BDT or Both (Both = two Excel files in one email). |
| Reply link | Each reply is linked to the exact BOQ revision that was sent. |
| Stack | Next.js (TypeScript), a backend API, PostgreSQL, a background worker. |
| Scale | 1 admin, 10-15 employees, 10-20 clients. |

Goals, in order: no shared Gmail access, correct reply routing, easy BOQ creation, one-click Excel export, and strong security.

## Architecture

&#91;embedded content: system architecture · 6 parts\]

Browsers only ever talk to the Next.js app. The background worker is the only part that holds the encrypted Gmail token, so no employee screen or API answer can reach the boss mailbox.

## Security model

The main rule: only the server talks to Gmail, and only the boss can connect it.

- **Gmail access:** OAuth 2.0 with scopes gmail.send and gmail.readonly (or gmail.modify). The refresh token is stored encrypted (AES-256-GCM) with a key kept in server secrets, never in the database or code.
- **Passwords:** argon2id hashes. Sessions use short-lived access tokens and refresh tokens stored only as SHA-256 hashes. Login rate limits and lockout after repeated failures. Optional 2-step login for admin.
- **Own-BOQ-only rule:** every query filters by owner unless the user has boq.view\_all. This is checked on the server for every request, not only in the screen.
- **Costing hidden:** cost, profit and the costing sheet are removed from API answers and Excel files unless the user has boq.costing.view or catalog.cost.view.
- **Transactions:** each request sets app.user\_id so the audit log shows who did what.
- **Reply privacy:** read mail headers first, fetch the full body only when it matches a sent BOQ, discard unmatched mail, ignore auto-replies. Employees never get inbox search.
- **Platform:** HTTPS only, secure cookies, CSRF protection, input validation, server-side file checks, daily encrypted database backups, secrets in environment variables.
- **Boss account:** the boss turns on Google 2-step verification. The password that was pasted into chat earlier must be changed now.

## Database changes

The current schema is a good base. It needs five new tables, one new column and four new permissions.

| Change | Purpose |
| --- | --- |
| mail\_accounts | The boss Gmail connection: address, encrypted refresh token, watch state, last history id. |
| boq\_emails | One row per send: BOQ and revision, sender, to/cc, subject, Gmail message id, thread id, Message-ID header, plus tag, attached export ids, currency choice. |
| inbound\_messages | Matched client replies: Gmail ids, sender, subject, body, received time, boq\_id (empty if unmatched), match method, assigned\_to. |
| notifications | Per user: type, BOQ, message, read time. |
| boqs.owner\_user\_id | Explicit owner so a BOQ can be reassigned. created\_by is not enough. |
| boq.view\_all | Admin and boss only. Estimators do not get it, so they see only their own BOQs. |
| boq.send | Allowed to send a BOQ by email. Given to estimators. |
| mail.unmatched.manage | See and assign unmatched replies. Admin only. |
| integrations.gmail.manage | Connect or disconnect the Gmail account. Admin only. |

Small fixes: the comment in user\_has\_permission says boq.view\_costing but the real code is boq.costing.view. The estimator role keeps boq.edit\_own and loses nothing else. The DB brand prices are empty, so those items give rate 0 until real costs are entered. Do not send a BOQ with a 0 rate: block the send and show a warning.

## Send and reply flow

A reply reaches the right employee because every sent email carries several tracking marks, and the server checks them in a fixed order.

**Sending**

1. The employee finishes the BOQ and clicks Send BOQ.
2. The employee picks the client, edits the message, and chooses USD, BDT or Both.
3. The server builds the editable Excel file or files from that exact revision and checks that no rate is 0.
4. The worker sends through the Gmail API as the boss. Subject carries a code, for example \[BOQ-2026-0012 R1\]. Reply-To uses a plus address, abccompany+boq0012r1@gmail.com.
5. The server saves the Gmail message id, thread id and Message-ID in boq\_emails and sets the BOQ status to Sent.
6. A sent BOQ is locked. To change it, the employee creates a new revision with create\_boq\_revision.

**Matching a reply, in this order**

1. Gmail threadId
2. In-Reply-To or References header against saved Message-IDs
3. Plus-address tag in the To field
4. BOQ code in the subject
5. Sender email, only if that client has exactly one open BOQ
6. Otherwise it goes to the Unmatched list, which only admin can see, with an Assign button

This covers a new mail that starts a new thread and a client who changes the subject. New replies arrive by Gmail push (Pub/Sub watch) with a 1-2 minute polling fallback, so a missed push never loses a reply.

A matched reply is saved on the exact revision that was sent, the owner gets a notification, and the reply shows inside that BOQ page. No other employee can see it.

## Excel export, notifications and calculation rules

**Excel.** The export runs on the server with ExcelJS, the same library the prototype uses. Sheets: Offer Summary, Imported Item, Local Item & Installation, Ventilation. The internal Costing sheet is added only for users with boq.costing.view and never in a file sent to a client. Files are saved in private object storage and logged in boq\_exports. Choosing Both creates one USD file and one BDT file.

**Notifications.** The owner gets an in-app notification and a badge for each matched reply, plus an optional email to their own address. Admin gets a notice for each unmatched reply.

**Calculation rules.** The same rules must give the same result in the screen, the Excel file and the database.

```latex
Rate = round( round( cost \times (1 + profit\%), 2 ) \times (1 - disc\%), 2 )
```

- Line A Rate in Tk = round(Rate USD × exchange rate, 2).
- AIT = base × a / (100 − a). VAT = (base + AIT) × v / (100 − v).
- A USD offer applies taxes only to lines B and C.
- Keep one shared calculation module in TypeScript and add tests that compare it with the SQL views to the paisa.

## Build phases, testing, risks and open items

**Phases**

1. **Foundation:** Next.js project, API, Postgres with the 3 current SQL files, login, roles, own-BOQ-only checks.
2. **BOQ core:** move the prototype screens to Next.js, save to the database, shared calculation module, revisions.
3. **Excel export:** server-side export, currency choice, file storage.
4. **Gmail send:** admin connects Gmail, send with attachments, subject code and plus tag, sent log.
5. **Replies:** thread and header matching, push plus polling, Unmatched list, notifications.
6. **Hardening:** rate limits, backups, audit review, load test with 15 users, admin guide.

**Testing.** Calculation tests (code against SQL), permission tests (employee A cannot read employee B's BOQ, reply or file), matching tests for each of the 6 rules, and a full send-and-reply test with a test Gmail account.

**Risks**

| Risk | Plan |
| --- | --- |
| Free Gmail OAuth in testing mode: refresh tokens can expire after 7 days | Publish the Google Cloud app, and complete Google verification for the mail scopes if required. Test this first, in phase 1. |
| Personal Gmail sending limits | 10-15 employees and 10-20 clients is low volume. Show a daily send counter and block sending near the limit. |
| Reply not matched | Unmatched list for admin, with Assign. |
| Cost leaking to clients | Costing sheet never attached to emails. Server checks the file before sending. |
| DB brand prices empty | Block send on 0 rate and warn. |
| Gmail token revoked | Show a banner to admin and pause sending until reconnected. |

**Open items**

- Boss Gmail address to confirm, and who will own the Google Cloud project.
- Where to host: one VPS or a managed platform.
- Email text template and signature.
- Real DB brand cost prices.
