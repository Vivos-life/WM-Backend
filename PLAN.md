# Backend plan

The API for What Matters: Node 24 + TypeScript run directly, Fastify, PostgreSQL. How it's built and the rules it keeps are
in `../AGENTS.md` (Backend). Whether it's testing or development time, and what both repos share, is in `../PLAN.md`.

## Where it stands (25 Nov 2026)

Everything the phone app needs locally is built and tested (`npm test`, real database): accounts with email verification,
password reset, sessions, the three sealed household records, the person's own photos in Cloudflare R2, account deletion with
30 days to change your mind, and code emails styled in the person's mood. It runs only on the developer's laptop: nothing is
deployed, nothing is backed up, and email goes to Mailtrap.

**Next:** phase 6 (deployment and backups), so the app can be tested away from the laptop's Wi-Fi. It needs two owner
decisions first (see `../PLAN.md`, Owner decisions): the VPS, and the live email sender.

## Phases

Status: **done** (built and tested), **built** (built, waiting for a phone test), **open** (not started), **blocked** (waits
for a decision).

| # | Phase | Status |
| --- | --- | --- |
| 1 | Accounts and sessions | done |
| 2 | Household records sync | done |
| 3 | Account deletion | done (removal from backups waits for phase 6) |
| 4 | Own photos (R2) | done |
| 5 | Email | done locally; live sender blocked |
| 6 | Deployment and backups | blocked |
| 7 | Encryption at rest | blocked |
| 8 | Server for the held-back screens | open (devices and complaints built; notifications open) |
| 9 | Membership and billing | blocked |
| 10 | After the phone app | open |

### 1. Accounts and sessions: done

`src/auth.ts`. Register, verify (6-digit code by email before the first sign-in), resend, login, refresh, logout, forgot and
reset. Passwords argon2id, 8 to 128 characters; access tokens 15 minutes; refresh tokens rotate, and a reused one revokes the
session; sign-in and sign-up errors are always `invalid_credentials`; reset and verify codes share the `codes` table.

### 2. Household records sync: done

`src/blobs.ts`: `GET /blobs`, `PUT /blobs/:kind` for `cfg`, `pf`, `plan`. Opaque sealed envelopes with a version each (409 on
conflict). The server never reads household data.

### 3. Account deletion: done

`GET /account`, `DELETE /account` (password again), `POST /account/keep`. Deletion is scheduled 30 days out; the server purges
due accounts at start and hourly, photos included. Not built: removal from backups within a further 35 days (phase 6).

### 4. Own photos: done

`src/photos.ts`: `PUT/GET/DELETE /photos/:id`, signed in only, JPEG up to 1 MB, kept under `u/<user id>/` in the private R2
bucket (EU jurisdiction). `npm run r2:check` tries the real bucket. A replaced photo is deleted by the phone
(`DELETE /photos/:id`); one it couldn't reach the server for stays until the account goes.

### 5. Email: done locally

`src/mail.ts`: SMTP through nodemailer (Mailtrap locally). Code emails are HTML in the person's mood (`users.mood`, set by
`PUT /account/mood`; the default mood for sign-up) plus the same words as plain text. `npm run mail:preview` writes all 18 to
`mail-preview/`; `npm run mail:check -- <email> [mood|all]` sends them, one every 10 seconds. **Blocked:** the live sender
(Resend or similar), owner's choice. The wording is not in the handoff and waits for owner review.

### 6. Deployment and backups: blocked

To build: the VPS (process manager, HTTPS, Postgres, migrations on start as now), backups to Cloudflare, removal of a deleted
account from backups within 35 days (the privacy notice promises it). Done when the app on a phone off the laptop's Wi-Fi signs
in, syncs and restores from a backup. **Waits for:** the VPS and the live email sender.

### 7. Encryption at rest: blocked

Every SQL statement is in `src/repo.ts` and every sensitive value passes its `lock()`/`unlock()`, so column encryption is added
in that one file (with an HMAC lookup column for emails). **Waits for:** the encryption strategy, which also decides the phone's
sealing (`../PLAN.md`).

### 8. Server for the held-back screens: open

What the phone's held-back screens still need (see `../mobile/PLAN.md`): reminders and notifications (a push service). Build
each with its screen.

Built: signed-in devices (`GET /account/devices`, `DELETE /account/devices/:id`; a device is a session family, named at
sign-in, last used at its latest refresh); complaints (`src/complaints.ts`: `POST /complaints` saves one with a reference and
emails it to `COMPLAINTS_TO`; `GET /complaints` lists the person's own, newest first, each with `replies`, always empty until
the admin panel writes them). Download your data and Move to a new phone need nothing
here: the phone holds the household, and signing in moves it.

### 9. Membership and billing: blocked

Six months free once, two-tap cancel, read-only after it ends (handoff). **Waits for:** the billing provider.

### 10. After the phone app: open

Data shared with the other Vivos apps through APIs each app builds as needed; Ask What Matters (an AI provider, opt-in);
monitoring; CI (the owner's call: none yet).
