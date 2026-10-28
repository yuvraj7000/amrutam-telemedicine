-- Up Migration
CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 128),
  request_hash text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  response_status int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idx_idem_expiry ON idempotency_keys (expires_at);

CREATE TABLE outbox_events (
  id bigserial PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  traceparent text,
  attempts int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_pending ON outbox_events (next_attempt_at, id)
  WHERE published_at IS NULL;

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid,
  user_agent text,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_rt_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_rt_family ON refresh_tokens (family_id);

CREATE TABLE mfa_backup_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz
);
CREATE INDEX idx_backup_user ON mfa_backup_codes (user_id) WHERE used_at IS NULL;

-- Down Migration
DROP TABLE IF EXISTS mfa_backup_codes;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS outbox_events;
DROP TABLE IF EXISTS idempotency_keys;