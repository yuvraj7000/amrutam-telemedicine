import { primaryPool } from '../../common/db/kysely.js';

export async function processConsultationExpiry(batchSize = 100): Promise<number> {
  const client = await primaryPool.connect();
  try {
    await client.query('BEGIN');
    const expired = await client.query<{ id: string; slot_id: string; patient_id: string }>(
      `WITH candidates AS (
         SELECT id
         FROM consultations
         WHERE status = 'PENDING_PAYMENT' AND expires_at <= now()
         ORDER BY expires_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE consultations AS consultation
       SET status = 'EXPIRED', version = version + 1
       FROM candidates
       WHERE consultation.id = candidates.id
       RETURNING consultation.id, consultation.slot_id, consultation.patient_id`,
      [Math.min(Math.max(1, batchSize), 500)],
    );

    if (expired.rows.length > 0) {
      await client.query(
        `UPDATE availability_slots AS slot
         SET status = 'AVAILABLE', held_by = NULL, held_until = NULL, version = version + 1
         FROM unnest($1::uuid[], $2::uuid[]) AS item(slot_id, patient_id)
         WHERE slot.id = item.slot_id AND slot.status = 'HELD' AND slot.held_by = item.patient_id`,
        [expired.rows.map((row) => row.slot_id), expired.rows.map((row) => row.patient_id)],
      );
    }

    await client.query('COMMIT');
    return expired.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
