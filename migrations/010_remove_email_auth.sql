-- Up Migration
DELETE FROM outbox_events
WHERE event_type IN ('auth.verify_email.requested', 'auth.reset_password.requested');

DROP TABLE IF EXISTS auth_email_tokens;
ALTER TABLE users DROP COLUMN IF EXISTS email_verified_at;

-- Down Migration
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;

CREATE TABLE auth_email_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_auth_email_tokens_user_purpose
  ON auth_email_tokens (user_id, purpose) WHERE consumed_at IS NULL;
CREATE INDEX idx_auth_email_tokens_expiry
  ON auth_email_tokens (expires_at);
