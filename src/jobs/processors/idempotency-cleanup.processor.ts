import { primaryPool } from '../../common/db/kysely.js';

const DELETE_BATCH_SIZE = 1_000;

export async function processIdempotencyCleanup(): Promise<{
  idempotencyKeys: number;
  outboxEvents: number;
  paymentEvents: number;
}> {
  const [idempotency, outbox, payments] = await Promise.all([
    primaryPool.query(
      `WITH expired AS (
         SELECT ctid FROM idempotency_keys
         WHERE expires_at < now()
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM idempotency_keys AS key USING expired
       WHERE key.ctid = expired.ctid`,
      [DELETE_BATCH_SIZE],
    ),
    primaryPool.query(
      `WITH old_events AS (
         SELECT id FROM outbox_events
         WHERE published_at < now() - interval '7 days'
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM outbox_events AS event USING old_events
       WHERE event.id = old_events.id`,
      [DELETE_BATCH_SIZE],
    ),
    primaryPool.query(
      `WITH old_events AS (
         SELECT id FROM payment_events
         WHERE processed_at IS NOT NULL AND received_at < now() - interval '30 days'
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       DELETE FROM payment_events AS event USING old_events
       WHERE event.id = old_events.id`,
      [DELETE_BATCH_SIZE],
    ),
  ]);
  return {
    idempotencyKeys: idempotency.rowCount ?? 0,
    outboxEvents: outbox.rowCount ?? 0,
    paymentEvents: payments.rowCount ?? 0,
  };
}
