import type { PoolClient } from 'pg';

import { primaryPool } from '../../common/db/kysely.js';

export interface OutboxEvent {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  traceparent: string | null;
  attempts: number;
}

const BATCH_SIZE = 100;
const CLAIM_LEASE_SECONDS = 30;

export async function claimOutboxEvents(
  limit = BATCH_SIZE,
  clientFactory: () => Promise<PoolClient> = () => primaryPool.connect(),
): Promise<OutboxEvent[]> {
  const client = await clientFactory();
  try {
    await client.query('BEGIN');
    const result = await client.query<OutboxEvent>(
      `WITH candidates AS (
         SELECT id
         FROM outbox_events
         WHERE published_at IS NULL AND next_attempt_at <= now()
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox_events AS event
       SET attempts = event.attempts + 1,
           next_attempt_at = now() + ($2 * interval '1 second')
       FROM candidates
       WHERE event.id = candidates.id
       RETURNING event.id::text, event.aggregate_type, event.aggregate_id,
                 event.event_type, event.payload, event.traceparent, event.attempts`,
      [Math.min(Math.max(1, limit), BATCH_SIZE), CLAIM_LEASE_SECONDS],
    );
    await client.query('COMMIT');
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markOutboxPublished(eventId: string): Promise<void> {
  await primaryPool.query(
    'UPDATE outbox_events SET published_at = COALESCE(published_at, now()) WHERE id = $1',
    [eventId],
  );
}

export async function retryOutboxEvent(event: OutboxEvent): Promise<void> {
  const delaySeconds = Math.min(300, 2 ** Math.min(event.attempts, 8));
  await primaryPool.query(
    `UPDATE outbox_events
     SET next_attempt_at = now() + ($2 * interval '1 second')
     WHERE id = $1 AND published_at IS NULL`,
    [event.id, delaySeconds],
  );
}
