import { primaryPool } from '../../common/db/kysely.js';
import type { AuditEntry } from './hash-chain.js';
import { inAuditTransaction, recordAudit, verifyAuditChain } from './hash-chain.js';

export type AuditFilters = {
  actorId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILURE';
  from: Date;
  to: Date;
  limit: number;
  cursor?: { createdAt: Date; id: string };
};

export class AuditRepository {
  async record(entry: AuditEntry): Promise<void> {
    await inAuditTransaction((trx) => recordAudit(trx, entry));
  }

  async list(
    filters: AuditFilters,
  ): Promise<{ data: Record<string, unknown>[]; nextCursor: string | null }> {
    const values: unknown[] = [filters.from, filters.to];
    const clauses = ['created_at >= $1', 'created_at < $2'];
    const optional: Array<[keyof AuditFilters, string]> = [
      ['actorId', 'actor_id'],
      ['action', 'action'],
      ['resourceType', 'resource_type'],
      ['resourceId', 'resource_id'],
      ['outcome', 'outcome'],
    ];
    for (const [key, column] of optional) {
      const value = filters[key];
      if (typeof value === 'string') {
        values.push(value);
        clauses.push(`${column}=$${values.length}`);
      }
    }
    if (filters.cursor) {
      values.push(filters.cursor.createdAt, filters.cursor.id);
      clauses.push(`(created_at,id) < ($${values.length - 1},$${values.length})`);
    }
    values.push(filters.limit + 1);
    const result = await primaryPool.query<Record<string, unknown>>(
      `SELECT id,created_at,chain_shard,seq,actor_id,actor_role,action,resource_type,resource_id,
              outcome,ip,user_agent,request_id,metadata,prev_hash,hash
         FROM audit_logs WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC,id DESC LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > filters.limit;
    const data = result.rows.slice(0, filters.limit);
    const last = data[data.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ createdAt: (last.created_at as Date).toISOString(), id: last.id }),
          ).toString('base64url')
        : null;
    return { data, nextCursor };
  }

  async verify(
    shard: number,
    from: Date,
    to: Date,
  ): Promise<{ checked: number; valid: boolean; firstBrokenSeq: string | null }> {
    return inAuditTransaction((trx) => verifyAuditChain(trx, shard, from, to));
  }
}
