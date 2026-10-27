import { sql, type Kysely, type Transaction } from 'kysely';

import { retry } from '../resilience/retry.js';
import { dbTxRetries } from '../observability/metrics.js';
import { db } from './kysely.js';
import type { Database } from './types.js';

export type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';
export type AfterCommit = () => void | Promise<void>;
export type TransactionWithHooks = Transaction<Database> & {
  afterCommit: (fn: AfterCommit) => void;
};
export interface TransactionOptions {
  retries?: number;
  isolation?: IsolationLevel;
  readOnly?: boolean;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function isTransientTransactionError(error: unknown): boolean {
  return ['40001', '40P01', '55P03'].includes(errorCode(error) ?? '');
}

export async function withTx<T>(
  opts: TransactionOptions,
  fn: (trx: TransactionWithHooks) => Promise<T>,
  database: Kysely<Database> = db,
): Promise<T> {
  return retry(
    async () => {
      const hooks: AfterCommit[] = [];
      const result = await database
        .transaction()
        .setIsolationLevel(opts.isolation ?? 'read committed')
        .execute(async (transaction: Transaction<Database>) => {
          if (opts.readOnly) await sql`set transaction read only`.execute(transaction);
          const trx = transaction as TransactionWithHooks;
          trx.afterCommit = (hook) => hooks.push(hook);
          return fn(trx);
        });
      for (const hook of hooks) await hook();
      return result;
    },
    {
      retries: opts.retries ?? 3,
      baseMs: 50,
      capMs: 500,
      retryOn: isTransientTransactionError,
      onRetry: (error) => {
        dbTxRetries.inc({ reason: errorCode(error) ?? 'unknown' });
      },
    },
  );
}
