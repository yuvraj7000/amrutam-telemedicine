-- +migrate Up
CREATE TABLE doctors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  display_name text NOT NULL,
  license_number text NOT NULL UNIQUE,
  verification_status verification_status NOT NULL DEFAULT 'PENDING',
  verified_by uuid REFERENCES users(id),
  verified_at timestamptz,
  specializations text[] NOT NULL DEFAULT '{}',
  languages text[] NOT NULL DEFAULT '{}',
  bio text,
  years_experience int CHECK (years_experience BETWEEN 0 AND 70),
  consultation_fee_minor int NOT NULL CHECK (consultation_fee_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'INR',
  modes consultation_mode[] NOT NULL DEFAULT '{VIDEO}',
  rating_avg numeric(3,2) NOT NULL DEFAULT 0,
  rating_count int NOT NULL DEFAULT 0,
  is_accepting boolean NOT NULL DEFAULT true,
  search_vector tsvector,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_doctors_search ON doctors USING gin (search_vector);
CREATE INDEX idx_doctors_name_trgm ON doctors USING gin (display_name gin_trgm_ops);
CREATE INDEX idx_doctors_spec ON doctors USING gin (specializations);
CREATE INDEX idx_doctors_lang ON doctors USING gin (languages);
CREATE INDEX idx_doctors_listing ON doctors (rating_avg DESC, id)
  WHERE verification_status = 'VERIFIED' AND is_accepting;
CREATE INDEX idx_doctors_fee ON doctors (consultation_fee_minor, id)
  WHERE verification_status = 'VERIFIED' AND is_accepting;
CREATE TRIGGER trg_doctors_updated BEFORE UPDATE ON doctors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION doctors_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('simple', coalesce(NEW.display_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(NEW.specializations, ' '), '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.bio, '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_doctors_sv
  BEFORE INSERT OR UPDATE OF display_name, specializations, bio ON doctors
  FOR EACH ROW EXECUTE FUNCTION doctors_search_vector_update();

CREATE TABLE availability_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES doctors(id),
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  status slot_status NOT NULL DEFAULT 'AVAILABLE',
  held_by uuid REFERENCES users(id),
  held_until timestamptz,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slot_time_valid CHECK (end_time > start_time AND end_time - start_time <= interval '4 hours'),
  CONSTRAINT slot_no_overlap EXCLUDE USING gist
    (doctor_id WITH =, tstzrange(start_time, end_time, '[)') WITH &&)
    WHERE (status <> 'CANCELLED')
);
CREATE INDEX idx_slots_doctor_time ON availability_slots (doctor_id, start_time)
  WHERE status = 'AVAILABLE';
CREATE INDEX idx_slots_held_expiry ON availability_slots (held_until)
  WHERE status = 'HELD';
CREATE TRIGGER trg_slots_updated BEFORE UPDATE ON availability_slots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- +migrate Down
DROP TABLE IF EXISTS availability_slots;
DROP FUNCTION IF EXISTS doctors_search_vector_update();
DROP TABLE IF EXISTS doctors;