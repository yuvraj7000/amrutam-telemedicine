import { primaryPool } from '../../common/db/kysely.js';

export async function processSlotHoldExpiry(batchSize = 500): Promise<number> {
  const result = await primaryPool.query(
    `WITH expired AS (
       SELECT slot.id
       FROM availability_slots AS slot
       WHERE slot.status = 'HELD'
         AND slot.held_until <= now()
         AND NOT EXISTS (
           SELECT 1 FROM consultations AS consultation WHERE consultation.slot_id = slot.id
         )
       ORDER BY slot.held_until, slot.id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE availability_slots AS slot
     SET status = 'AVAILABLE', held_by = NULL, held_until = NULL, version = version + 1
     FROM expired
     WHERE slot.id = expired.id AND slot.status = 'HELD'
     RETURNING slot.id`,
    [Math.min(Math.max(1, batchSize), 1_000)],
  );
  return result.rowCount ?? 0;
}
