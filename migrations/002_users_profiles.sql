-- Up Migration
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  phone text,
  password_hash text NOT NULL,
  role user_role NOT NULL DEFAULT 'PATIENT',
  status user_status NOT NULL DEFAULT 'ACTIVE',
  mfa_enabled boolean NOT NULL DEFAULT false,
  mfa_secret_enc text,
  failed_login_count int NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  tokens_valid_after timestamptz NOT NULL DEFAULT now(),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  consent_version text,
  consented_at timestamptz
);
CREATE INDEX idx_users_role_status ON users(role, status) WHERE deleted_at IS NULL;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name text NOT NULL,
  gender text CHECK (gender IN ('MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED')),
  date_of_birth_enc text,
  address_enc text,
  emergency_contact_enc text,
  locale text NOT NULL DEFAULT 'en-IN',
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Down Migration
DROP TABLE IF EXISTS profiles;
DROP TABLE IF EXISTS users;