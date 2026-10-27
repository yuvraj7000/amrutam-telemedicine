import 'dotenv/config';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

const ids = {
  admin: '11111111-1111-1111-1111-111111110001',
  doctor1: '11111111-1111-1111-1111-111111110002',
  doctor2: '11111111-1111-1111-1111-111111110003',
  patient1: '11111111-1111-1111-1111-111111110004',
  patient2: '11111111-1111-1111-1111-111111110005',
  doctorProfile1: '22222222-2222-2222-2222-222222220001',
  doctorProfile2: '22222222-2222-2222-2222-222222220002',
  slot1: '33333333-3333-3333-3333-333333330001',
  slot2: '33333333-3333-3333-3333-333333330002',
  slot3: '33333333-3333-3333-3333-333333330003',
  consultation1: '44444444-4444-4444-4444-444444440001',
  consultation2: '44444444-4444-4444-4444-444444440002',
  payment1: '55555555-5555-5555-5555-555555550001',
  payment2: '55555555-5555-5555-5555-555555550002',
} as const;

const credentials = [
  ['admin@amrutam.test', 'ADMIN'],
  ['dr.sharma@amrutam.test', 'DOCTOR'],
  ['dr.iyer@amrutam.test', 'DOCTOR'],
  ['asha@example.com', 'PATIENT'],
  ['ravi@example.com', 'PATIENT'],
] as const;

async function main(): Promise<void> {
  const passwordByEmail = new Map(
    credentials.map(([email]) => [email, `demo-${randomBytes(8).toString('hex')}`]),
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const userRows = [
      [ids.admin, credentials[0][0], 'ADMIN', true],
      [ids.doctor1, credentials[1][0], 'DOCTOR', true],
      [ids.doctor2, credentials[2][0], 'DOCTOR', true],
      [ids.patient1, credentials[3][0], 'PATIENT', false],
      [ids.patient2, credentials[4][0], 'PATIENT', false],
    ] as const;
    for (const [id, email, role, mfaEnabled] of userRows) {
      await client.query(
        `INSERT INTO users (id, email, password_hash, role, mfa_enabled)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role, mfa_enabled = EXCLUDED.mfa_enabled`,
        [id, email, await argon2.hash(passwordByEmail.get(email)!), role, mfaEnabled],
      );
    }
    await client.query(
      `INSERT INTO profiles (user_id, full_name) VALUES
       ($1, 'Admin'), ($2, 'Dr. Meera Sharma'), ($3, 'Dr. Kiran Iyer'),
       ($4, 'Asha'), ($5, 'Ravi')
       ON CONFLICT (user_id) DO NOTHING`,
      [ids.admin, ids.doctor1, ids.doctor2, ids.patient1, ids.patient2],
    );
    await client.query(
      `INSERT INTO doctors
       (id, user_id, display_name, license_number, verification_status, specializations, languages,
        consultation_fee_minor, rating_avg, rating_count)
       VALUES
       ($1, $2, 'Dr. Meera Sharma', 'AYU-0001', 'VERIFIED', '{ayurveda,general-medicine}', '{en,hi}', 50000, 4.80, 312),
       ($3, $4, 'Dr. Kiran Iyer', 'AYU-0002', 'VERIFIED', '{panchakarma}', '{en,ta}', 80000, 4.60, 180)
       ON CONFLICT (id) DO NOTHING`,
      [ids.doctorProfile1, ids.doctor1, ids.doctorProfile2, ids.doctor2],
    );
    await client.query(
      `INSERT INTO availability_slots (id, doctor_id, start_time, end_time, status) VALUES
       ($1, $2, date_trunc('day', now()) + interval '1 day 4 hours 30 minutes', date_trunc('day', now()) + interval '1 day 5 hours', 'AVAILABLE'),
       ($3, $2, date_trunc('day', now()) + interval '1 day 5 hours', date_trunc('day', now()) + interval '1 day 5 hours 30 minutes', 'HELD'),
       ($4, $2, date_trunc('day', now()) + interval '1 day 5 hours 30 minutes', date_trunc('day', now()) + interval '1 day 6 hours', 'BOOKED')
       ON CONFLICT (id) DO NOTHING`,
      [ids.slot1, ids.doctorProfile1, ids.slot2, ids.slot3],
    );
    await client.query(
      `INSERT INTO consultations
       (id, patient_id, doctor_id, slot_id, status, scheduled_start, scheduled_end, fee_minor, expires_at)
       VALUES
       ($1, $2, $3, $4, 'PENDING_PAYMENT', date_trunc('day', now()) + interval '1 day 5 hours',
        date_trunc('day', now()) + interval '1 day 5 hours 30 minutes', 50000, now() + interval '10 minutes'),
       ($5, $6, $3, $7, 'CONFIRMED', date_trunc('day', now()) + interval '1 day 5 hours 30 minutes',
        date_trunc('day', now()) + interval '1 day 6 hours', 50000, NULL)
       ON CONFLICT (id) DO NOTHING`,
      [
        ids.consultation1,
        ids.patient1,
        ids.doctorProfile1,
        ids.slot2,
        ids.consultation2,
        ids.patient2,
        ids.slot3,
      ],
    );
    await client.query(
      `INSERT INTO payments
       (id, consultation_id, patient_id, amount_minor, status, provider, provider_payment_id)
       VALUES
       ($1, $2, $3, 50000, 'PENDING', 'mock', 'mock_pi_001'),
       ($4, $5, $6, 50000, 'SUCCEEDED', 'mock', 'mock_pi_002')
       ON CONFLICT (id) DO NOTHING`,
      [
        ids.payment1,
        ids.consultation1,
        ids.patient1,
        ids.payment2,
        ids.consultation2,
        ids.patient2,
      ],
    );
    await client.query('COMMIT');
    console.log('Generated demo passwords:');
    for (const [email, password] of passwordByEmail) console.log(`${email}: ${password}`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
