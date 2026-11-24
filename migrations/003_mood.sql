-- The person's colour mood (one of the handoff's nine), so emails match the app. Null until the phone sends one: the default.
-- Not checked here: the API accepts only the moods in src/design-tokens.json, so a new mood needs no migration.
ALTER TABLE users ADD COLUMN mood text;
