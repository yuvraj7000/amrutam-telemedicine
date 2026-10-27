import { Pool } from 'pg';
import {
  applyMigrations,
  startTestContainers,
  stopTestContainers,
  TestContainers,
} from '../helpers/containers.js';

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

  it('can migrate down all migrations and back up', async () => {
    await applyMigrations(containers.postgres.getConnectionUri(), 'down', 8);
    const afterDown = await pool.query(
      `SELECT to_regclass('public.users') AS users, to_regclass('public.analytics_daily') AS analytics`,
    );
    expect(afterDown.rows[0]).toEqual({ users: null, analytics: null });

    await applyMigrations(containers.postgres.getConnectionUri(), 'up');
    const afterUp = await pool.query(
      `SELECT to_regclass('public.users') AS users, to_regclass('public.analytics_daily') AS analytics`,
    );
    expect(afterUp.rows[0].users).toBe('users');
    expect(afterUp.rows[0].analytics).toBe('analytics_daily');
  });
});
