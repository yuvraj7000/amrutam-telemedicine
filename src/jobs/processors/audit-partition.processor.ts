import { primaryPool } from '../../common/db/kysely.js';

export async function processAuditPartition(): Promise<void> {
  await primaryPool.query(
    `SELECT audit_create_partition(
       (date_trunc('month', current_date)::date + (month_offset || ' month')::interval)::date
     )
     FROM generate_series(1, 3) AS month_offset`,
  );
}
