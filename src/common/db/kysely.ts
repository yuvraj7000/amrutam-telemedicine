import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { env } from '../../config/env.js';
import type { Database } from './types.js';

const { Pool } = pg;

function createPool(connectionString: string): pg.Pool {
  return new Pool({
    connectionString,
    max: env.DB_POOL_MAX,
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: env.DB_IDLE_IN_TX_TIMEOUT_MS,
  });
}

export const primaryPool = createPool(env.DATABASE_URL);
export const readPool = env.DATABASE_READ_URL ? createPool(env.DATABASE_READ_URL) : undefined;
export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: primaryPool }),
});
export const readDb = readPool
  ? new Kysely<Database>({ dialect: new PostgresDialect({ pool: readPool }) })
  : db;

export async function checkDatabase(): Promise<void> {
  await primaryPool.query('SELECT 1');
}

export async function closeDatabase(): Promise<void> {
  await Promise.all([
    primaryPool.end(),
    readPool ? readPool.end() : Promise.resolve(),
  ]);
}
