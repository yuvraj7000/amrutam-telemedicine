-- Up Migration
CREATE TABLE prescriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations(id),
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  patient_id uuid NOT NULL REFERENCES users(id),
  version int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'ISSUED' CHECK (status IN ('ISSUED', 'REVOKED')),
  payload_enc text NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT now(),
  valid_until timestamptz,
  pdf_object_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consultation_id, version)
);
CREATE INDEX idx_rx_patient ON prescriptions (patient_id, issued_at DESC);
CREATE INDEX idx_rx_doctor ON prescriptions (doctor_id, issued_at DESC);

-- Down Migration
DROP TABLE IF EXISTS prescriptions;