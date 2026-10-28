-- Up Migration
CREATE TABLE consultations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES users(id),
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  slot_id uuid NOT NULL REFERENCES availability_slots(id),
  status consultation_status NOT NULL DEFAULT 'PENDING_PAYMENT',
  mode consultation_mode NOT NULL DEFAULT 'VIDEO',
  scheduled_start timestamptz NOT NULL,
  scheduled_end timestamptz NOT NULL,
  fee_minor int NOT NULL,
  currency char(3) NOT NULL DEFAULT 'INR',
  reason_enc text,
  doctor_notes_enc text,
  meeting_url text,
  expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES users(id),
  cancel_reason text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_consultation_live_slot ON consultations (slot_id)
  WHERE status IN ('PENDING_PAYMENT', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED');
CREATE INDEX idx_consult_patient ON consultations (patient_id, scheduled_start DESC);
CREATE INDEX idx_consult_doctor ON consultations (doctor_id, scheduled_start DESC);
CREATE INDEX idx_consult_expiry ON consultations (expires_at) WHERE status = 'PENDING_PAYMENT';
CREATE INDEX idx_consult_status_time ON consultations (status, scheduled_start);
CREATE TRIGGER trg_consult_updated BEFORE UPDATE ON consultations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations(id),
  patient_id uuid NOT NULL REFERENCES users(id),
  amount_minor int NOT NULL CHECK (amount_minor >= 0),
  refunded_minor int NOT NULL DEFAULT 0 CHECK (refunded_minor <= amount_minor),
  currency char(3) NOT NULL DEFAULT 'INR',
  status payment_status NOT NULL DEFAULT 'INITIATED',
  provider text NOT NULL,
  provider_payment_id text UNIQUE,
  client_secret text,
  failure_reason text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_consult ON payments (consultation_id);
CREATE INDEX idx_payments_status ON payments (status, created_at)
  WHERE status IN ('INITIATED', 'PENDING');
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payment_events (
  id bigserial PRIMARY KEY,
  provider_event_id text NOT NULL UNIQUE,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

-- Down Migration
DROP TABLE IF EXISTS payment_events;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS consultations;