-- Signed-in devices (the handoff's Privacy sheet): the name the phone gives itself at sign-in, carried through each refresh.
-- Null for sessions from before this, and for a phone that sends none.
ALTER TABLE sessions ADD COLUMN device text;
