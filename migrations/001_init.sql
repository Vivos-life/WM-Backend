-- Accounts, sessions and the household's sealed records.
-- The server never reads household data: blobs.envelope is opaque bytes sealed on the phone (see src/blobs.ts).

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Trimmed and lower-cased before it is stored, so one address is one account.
  email         text NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per token pair. Refreshing rotates: the old row is marked rotated and a new row joins the same family.
-- Presenting a rotated refresh token again means it was copied, so the whole family is revoked.
CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family          uuid NOT NULL,
  access_hash     bytea NOT NULL UNIQUE,
  access_expires  timestamptz NOT NULL,
  refresh_hash    bytea NOT NULL UNIQUE,
  refresh_expires timestamptz NOT NULL,
  rotated_at      timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_family ON sessions(family);

-- The three records of the handoff's data model (handoff/docs/DATA-MODEL.md): settings, records, money plan.
CREATE TABLE blobs (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('cfg', 'pf', 'plan')),
  version    integer NOT NULL CHECK (version > 0),
  envelope   bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, kind)
);

-- Password reset: a 6-digit code sent by email, stored only as SHA-256, single use, short-lived, few attempts.
CREATE TABLE reset_codes (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash  bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts   integer NOT NULL DEFAULT 0
);
