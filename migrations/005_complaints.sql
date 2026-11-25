-- Complaints about how we handled someone's information (the handoff's Privacy sheet: acknowledged within 30 days). Kept
-- here for whoever answers them (an admin panel later) and emailed to COMPLAINTS_TO. They go with the account.
CREATE TABLE complaints (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ref        text NOT NULL UNIQUE,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
