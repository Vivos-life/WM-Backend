-- Email verification: an account can sign in only once a code sent to its email has been entered.
ALTER TABLE users ADD COLUMN verified_at timestamptz;
-- Accounts made before verification existed keep working.
UPDATE users SET verified_at = created_at;

-- One table for every emailed code: reset_codes gains a purpose, one live code per user and purpose.
ALTER TABLE reset_codes RENAME TO codes;
ALTER TABLE codes ADD COLUMN purpose text NOT NULL DEFAULT 'reset' CHECK (purpose IN ('reset', 'verify'));
ALTER TABLE codes ALTER COLUMN purpose DROP DEFAULT;
ALTER TABLE codes DROP CONSTRAINT reset_codes_pkey, ADD PRIMARY KEY (user_id, purpose);

-- Deleting an account schedules it 30 days out (the handoff's privacy notice); the purge removes it after that.
-- Until then the person can sign in, see and download everything, and keep the account.
ALTER TABLE users ADD COLUMN delete_at timestamptz;
CREATE INDEX users_delete_at ON users(delete_at) WHERE delete_at IS NOT NULL;
