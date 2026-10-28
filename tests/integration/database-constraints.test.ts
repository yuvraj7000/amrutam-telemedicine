import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { EncryptionService } from '../../src/common/crypto/encryption.service.js';
import { EnvKeyProvider } from '../../src/common/crypto/key-provider.js';
import { AuthRepository } from '../../src/modules/auth/auth.repository.js';
import { DoctorsRepository } from '../../src/modules/doctors/doctors.repository.js';
import { applyMigrations, startTestContainers, stopTestContainers } from '../helpers/containers.js';
import type { TestContainers } from '../helpers/containers.js';

describe('database migrations and invariants', () => {
  let containers: TestContainers;
  let pool: Pool;

  beforeAll(async () => {
    containers = await startTestContainers();
    pool = containers.pool;
  }, 120_000);

  afterAll(async () => {
    if (containers) {
      await stopTestContainers(containers);
    }
  }, 120_000);

  it('rejects overlapping slots and duplicate live consultations', async () => {
    const doctor = '22222222-2222-2222-2222-222222222201';
    const patient = '11111111-1111-1111-1111-111111111201';
    await pool.query(
      `INSERT INTO users (id, email, password_hash) VALUES
       ($1, $2, 'test'), ($3, $4, 'test')`,
      [doctor.replace('2222', '1111'), 'doctor@example.test', patient, 'patient@example.test'],
    );
    await pool.query(
      `INSERT INTO doctors (id, user_id, display_name, license_number, verification_status)
       VALUES ($1, $2, 'Dr Test', 'TEST-LICENSE', 'VERIFIED')`,
      [doctor, doctor.replace('2222', '1111')],
    );
    const slot = '33333333-3333-3333-3333-333333333301';
    await pool.query(
      `INSERT INTO availability_slots (id, doctor_id, start_time, end_time)
       VALUES ($1, $2, '2099-01-01T10:00:00Z', '2099-01-01T10:30:00Z')`,
      [slot, doctor],
    );
    await expect(
      pool.query(
        `INSERT INTO availability_slots (doctor_id, start_time, end_time)
         VALUES ($1, '2099-01-01T10:15:00Z', '2099-01-01T10:45:00Z')`,
        [doctor],
      ),
    ).rejects.toMatchObject({ code: '23P01' });

    await pool.query(
      `INSERT INTO consultations
       (id, patient_id, doctor_id, slot_id, status, scheduled_start, scheduled_end, fee_minor)
       VALUES ($1, $2, $3, $4, 'CONFIRMED', '2099-01-01T10:00:00Z',
               '2099-01-01T10:30:00Z', 50000)`,
      ['44444444-4444-4444-4444-444444444401', patient, doctor, slot],
    );
    await expect(
      pool.query(
        `INSERT INTO consultations
         (patient_id, doctor_id, slot_id, status, scheduled_start, scheduled_end, fee_minor)
         VALUES ($1, $2, $3, 'PENDING_PAYMENT', '2099-01-01T10:00:00Z',
                 '2099-01-01T10:30:00Z', 50000)`,
        [patient, doctor, slot],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'uq_consultation_live_slot' });
  });

  it('stores MFA secrets as encrypted ciphertext', async () => {
    const userId = '11111111-1111-1111-1111-111111111299';
    const secret = 'JBSWY3DPEHPK3PXP';
    const encryption = new EncryptionService(
      new EnvKeyProvider({
        ENC_KEYS: { '1': Buffer.alloc(32, 7).toString('base64') },
        ENC_ACTIVE_VERSION: 1,
      }),
    );
    const ciphertext = await encryption.encrypt(secret, `users.mfa_secret_enc:${userId}`);
    await pool.query(
      'INSERT INTO users (id,email,password_hash,mfa_secret_enc) VALUES ($1,$2,$3,$4)',
      [userId, 'mfa-ciphertext@example.test', 'test-hash', ciphertext],
    );

    const raw = await pool.query<{ mfa_secret_enc: string }>(
      'SELECT mfa_secret_enc FROM users WHERE id=$1',
      [userId],
    );
    expect(raw.rows[0]?.mfa_secret_enc).toMatch(/^v1:/);
    expect(raw.rows[0]?.mfa_secret_enc).not.toContain(secret);
    await expect(
      encryption.decrypt(raw.rows[0]?.mfa_secret_enc ?? '', `users.mfa_secret_enc:${userId}`),
    ).resolves.toBe(secret);
  });

  it('updates doctor verification status and verified timestamp', async () => {
    const adminId = randomUUID();
    const doctorUserId = randomUUID();
    const doctorId = randomUUID();
    await pool.query(
      `INSERT INTO users (id,email,password_hash,role) VALUES
       ($1,$2,'test','ADMIN'), ($3,$4,'test','DOCTOR')`,
      [
        adminId,
        `${adminId}@example.test`,
        doctorUserId,
        `${doctorUserId}@example.test`,
      ],
    );
    await pool.query(
      `INSERT INTO doctors (id,user_id,display_name,license_number,consultation_fee_minor)
       VALUES ($1,$2,'Dr Review',$3,50000)`,
      [doctorId, doctorUserId, `LICENSE-${doctorId}`],
    );

    const repository = new DoctorsRepository(pool);
    const verified = await repository.setVerification(doctorId, 'VERIFIED', adminId);
    expect(verified).toMatchObject({
      id: doctorId,
      verification_status: 'VERIFIED',
    });
    const verifiedAt = await pool.query<{ verified_at: Date | null }>(
      'SELECT verified_at FROM doctors WHERE id=$1',
      [doctorId],
    );
    expect(verifiedAt.rows[0]?.verified_at).toBeInstanceOf(Date);

    const rejected = await repository.setVerification(doctorId, 'REJECTED', adminId);
    expect(rejected).toMatchObject({
      id: doctorId,
      verification_status: 'REJECTED',
    });
    const rejectedAt = await pool.query<{ verified_at: Date | null }>(
      'SELECT verified_at FROM doctors WHERE id=$1',
      [doctorId],
    );
    expect(rejectedAt.rows[0]?.verified_at).toBeNull();
  });

  it('registers accounts without email verification requirements', async () => {
    const repository = new AuthRepository(pool);
    const user = await repository.register(
      {
        email: `${randomUUID()}@example.test`,
        passwordHash: 'initial-password-hash',
        fullName: 'Email Test',
        role: 'PATIENT',
      },
    );
    expect(await repository.findUser(user.email)).toMatchObject({
      id: user.id,
      email: user.email,
      password_hash: 'initial-password-hash',
    });
  });

  it('protects audit logs and creates the current and future partitions', async () => {
    const inserted = await pool.query(
      `INSERT INTO audit_logs
       (chain_shard, seq, action, resource_type, outcome, prev_hash, hash)
       VALUES (0, 1, 'test', 'test', 'SUCCESS', repeat('0', 64), repeat('1', 64))
       RETURNING id, created_at`,
    );
    const row = inserted.rows[0] as { id: string; created_at: Date };
    await expect(
      pool.query('UPDATE audit_logs SET action = $1 WHERE id = $2', ['changed', row.id]),
    ).rejects.toThrow('audit_logs is append-only');
    await expect(pool.query('DELETE FROM audit_logs WHERE id = $1', [row.id])).rejects.toThrow(
      'audit_logs is append-only',
    );

    const partitions = await pool.query(
      `SELECT c.relname
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       WHERE p.relname = 'audit_logs'`,
    );
    expect(partitions.rows.length).toBe(4);
    expect(partitions.rows.map((partition) => partition.relname)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^audit_logs_\\d{4}_\\d{2}$/)]),
    );
  });

  it('rolls back and reapplies the email-auth removal migration', async () => {
    const databaseUrl = containers.postgres.getConnectionUri();
    await applyMigrations(databaseUrl, 'down', 1);
    const afterDown = await pool.query(
      `SELECT to_regclass('public.auth_email_tokens') AS tokens,
              EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='users' AND column_name='email_verified_at') AS email_verified_at`,
    );
    expect(afterDown.rows[0]).toEqual({ tokens: 'auth_email_tokens', email_verified_at: true });

    await applyMigrations(databaseUrl, 'up', 1);
    const afterUp = await pool.query(
      `SELECT to_regclass('public.auth_email_tokens') AS tokens,
              EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name='users' AND column_name='email_verified_at') AS email_verified_at`,
    );
    expect(afterUp.rows[0]).toEqual({ tokens: null, email_verified_at: false });
  });
});
