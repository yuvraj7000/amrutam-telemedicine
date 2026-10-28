-- Up Migration
CREATE TABLE audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  chain_shard smallint NOT NULL,
  seq bigint NOT NULL,
  actor_id uuid,
  actor_role text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  outcome text NOT NULL CHECK (outcome IN ('SUCCESS', 'DENIED', 'FAILURE')),
  ip inet,
  user_agent text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  prev_hash text NOT NULL,
  hash text NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE INDEX idx_audit_actor ON audit_logs (actor_id, created_at DESC);
CREATE INDEX idx_audit_resource ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs (action, created_at DESC);
CREATE UNIQUE INDEX uq_audit_shard_seq ON audit_logs (chain_shard, seq, created_at);

CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER trg_audit_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

CREATE OR REPLACE FUNCTION audit_create_partition(month_start date) RETURNS void AS $$
DECLARE
  part text := 'audit_logs_' || to_char(month_start, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
    part, month_start, (month_start + interval '1 month')::date
  );
END;
$$ LANGUAGE plpgsql;
SELECT audit_create_partition(
  (date_trunc('month', now())::date + (i || ' month')::interval)::date
)
FROM generate_series(0, 3) i;

CREATE TABLE audit_chain_heads (
  chain_shard smallint PRIMARY KEY,
  last_seq bigint NOT NULL DEFAULT 0,
  last_hash text NOT NULL DEFAULT repeat('0', 64)
);
INSERT INTO audit_chain_heads (chain_shard) SELECT generate_series(0, 15);

-- Down Migration
DROP TABLE IF EXISTS audit_chain_heads;
DROP FUNCTION IF EXISTS audit_create_partition(date);
DROP FUNCTION IF EXISTS audit_logs_immutable();
DROP TABLE IF EXISTS audit_logs CASCADE;