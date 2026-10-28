import type { PoolClient } from 'pg';
import { primaryPool, readPool } from '../../common/db/kysely.js';
import { NotFoundError } from '../../common/errors/index.js';
import { recordAudit } from '../audit/hash-chain.js';
import type { IdempotencyService } from '../idempotency/idempotency.service.js';

export type SlotRow = {
  id: string;
  doctor_id: string;
  start_time: Date;
  end_time: Date;
  status: string;
};
export class AvailabilityRepository {
  constructor(private readonly idempotency?: IdempotencyService) {}
  async doctorIdForUser(userId: string): Promise<string | undefined> {
    const result = await primaryPool.query<{ id: string }>(
      'SELECT id FROM doctors WHERE user_id=$1',
      [userId],
    );
    return result.rows[0]?.id;
  }

  async createSlots(
    userId: string,
    slots: { start: Date; end: Date }[],
    key: string | undefined,
    requestBody: unknown,
  ): Promise<{ created: number; skipped: { start: string; reason: string }[]; replay: boolean }> {
    const client = await primaryPool.connect();
    const skipped: { start: string; reason: string }[] = [];
    let created = 0;
    try {
      await client.query('BEGIN');
      if (!this.idempotency) throw new Error('Idempotency service is required for slot creation.');
      const idem = await this.idempotency.begin(
        client,
        userId,
        key,
        'POST',
        '/doctors/me/slots',
        requestBody,
      );
      if (idem.replay) {
        await client.query('COMMIT');
        return {
          ...(idem.body as { created: number; skipped: { start: string; reason: string }[] }),
          replay: true,
        };
      }
      const doctor = await client.query<{ id: string }>(
        'SELECT id FROM doctors WHERE user_id=$1 FOR UPDATE',
        [userId],
      );
      if (!doctor.rows[0]) throw new NotFoundError('Doctor profile was not found.');
      for (let index = 0; index < slots.length; index += 1) {
        const value = slots[index]!;
        await client.query(`SAVEPOINT slot_${index}`);
        try {
          await client.query(
            `INSERT INTO availability_slots (doctor_id,start_time,end_time) VALUES ($1,$2,$3)`,
            [doctor.rows[0].id, value.start, value.end],
          );
          await client.query(`RELEASE SAVEPOINT slot_${index}`);
          created += 1;
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT slot_${index}`);
          await client.query(`RELEASE SAVEPOINT slot_${index}`);
          if (isOverlapError(error))
            skipped.push({ start: value.start.toISOString(), reason: 'OVERLAP' });
          else throw error;
        }
      }
      const response = { created, skipped };
      await recordAudit(client, {
        actorId: userId,
        actorRole: 'DOCTOR',
        action: 'availability.slots.create',
        resourceType: 'doctor',
        resourceId: doctor.rows[0].id,
        outcome: 'SUCCESS',
        metadata: { created, skipped: skipped.length },
      });
      await this.idempotency.complete(client, userId, key!, 201, response);
      await client.query('COMMIT');
      return { ...response, replay: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listDoctorSlots(
    userId: string,
    from: string,
    to: string,
    status?: string,
  ): Promise<SlotRow[]> {
    const values: unknown[] = [userId, from, to];
    const statusClause = status ? ` AND s.status=$${values.push(status)}` : '';
    const result = await primaryPool.query<SlotRow>(
      `SELECT s.id,s.doctor_id,s.start_time,s.end_time,s.status FROM availability_slots s
       JOIN doctors d ON d.id=s.doctor_id WHERE d.user_id=$1 AND s.start_time >= $2 AND s.start_time < $3${statusClause}
       ORDER BY s.start_time,s.id`,
      values,
    );
    return result.rows;
  }

  async publicAvailability(doctorId: string, from: string, to: string): Promise<SlotRow[]> {
    const result = await (readPool ?? primaryPool).query<SlotRow>(
      `SELECT id,doctor_id,start_time,end_time,status FROM availability_slots
       WHERE doctor_id=$1 AND start_time >= $2::date AND start_time < ($3::date + interval '1 day')
       AND (status='AVAILABLE' OR (status='HELD' AND held_until < now()))
       ORDER BY start_time,id`,
      [doctorId, from, to],
    );
    return result.rows;
  }

  async deleteAvailableSlot(userId: string, slotId: string): Promise<boolean> {
    const result = await primaryPool.query(
      `UPDATE availability_slots s SET status='CANCELLED',version=version+1
       FROM doctors d WHERE s.id=$1 AND s.doctor_id=d.id AND d.user_id=$2 AND s.status='AVAILABLE'`,
      [slotId, userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async tryHold(
    client: PoolClient,
    slotId: string,
    userId: string,
    holdMinutes: number,
    minLeadMinutes: number,
  ): Promise<SlotRow | undefined> {
    const result = await client.query<SlotRow>(
      `UPDATE availability_slots SET status='HELD',held_by=$2,
       held_until=now()+($3::text || ' minutes')::interval,version=version+1
       WHERE id=$1 AND start_time > now()+($4::text || ' minutes')::interval
       AND (status='AVAILABLE' OR (status='HELD' AND held_until < now()))
       RETURNING id,doctor_id,start_time,end_time,status`,
      [slotId, userId, holdMinutes, minLeadMinutes],
    );
    return result.rows[0];
  }
}

function isOverlapError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23P01';
}
