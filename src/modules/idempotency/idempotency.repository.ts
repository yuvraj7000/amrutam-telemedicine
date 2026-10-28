import type { PoolClient } from 'pg';

export type IdempotencyRecord = {
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
};

export class IdempotencyRepository {
  async begin(
    client: PoolClient,
    values: {
      userId: string;
      key: string;
      requestHash: string;
      method: string;
      path: string;
      ttlHours: number;
    },
  ): Promise<{ inserted: boolean; record: IdempotencyRecord }> {
    await client.query(
      'DELETE FROM idempotency_keys WHERE user_id=$1 AND key=$2 AND expires_at<=now()',
      [values.userId, values.key],
    );
    const inserted = await client.query<IdempotencyRecord>(
      `INSERT INTO idempotency_keys (user_id,key,request_hash,method,path,expires_at)
       VALUES ($1,$2,$3,$4,$5,now()+($6::text || ' hours')::interval)
       ON CONFLICT (user_id,key) DO NOTHING
       RETURNING request_hash,response_status,response_body`,
      [values.userId, values.key, values.requestHash, values.method, values.path, values.ttlHours],
    );
    if (inserted.rows[0]) return { inserted: true, record: inserted.rows[0] };
    const existing = await client.query<IdempotencyRecord>(
      'SELECT request_hash,response_status,response_body FROM idempotency_keys WHERE user_id=$1 AND key=$2 FOR UPDATE',
      [values.userId, values.key],
    );
    if (!existing.rows[0]) throw new Error('Idempotency row disappeared during transaction');
    return { inserted: false, record: existing.rows[0] };
  }

  async complete(
    client: PoolClient,
    userId: string,
    key: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    await client.query(
      'UPDATE idempotency_keys SET response_status=$3,response_body=$4::jsonb WHERE user_id=$1 AND key=$2',
      [userId, key, status, JSON.stringify(body)],
    );
  }
}
