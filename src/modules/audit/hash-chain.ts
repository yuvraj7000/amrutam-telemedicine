import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { canonicalJson, sha256 } from '../../common/crypto/hash.js';
import { primaryPool } from '../../common/db/kysely.js';

const EMPTY_HASH = '0'.repeat(64);
const SHARD_COUNT = 16;

export type AuditOutcome = 'SUCCESS' | 'DENIED' | 'FAILURE';
export type AuditContext = {
  actorId?: string | null;
  actorRole?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};
export type AuditEntry = AuditContext & {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  outcome: AuditOutcome;
  metadata?: Record<string, unknown>;
};

type ChainRow = QueryResultRow & {
  id: string;
  created_at: Date;
  chain_shard: number;
  seq: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: AuditOutcome;
  metadata: Record<string, unknown>;
  prev_hash: string;
  hash: string;
};

export function auditShard(
  resourceId: string | null | undefined,
  actorId: string | null | undefined,
): number {
  const value = Buffer.from(`${resourceId ?? ''}${actorId ?? ''}`, 'utf8');
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return ((crc ^ 0xffffffff) >>> 0) % SHARD_COUNT;
}

export function auditHash(
  prevHash: string,
  row: Pick<
    ChainRow,
    | 'id'
    | 'created_at'
    | 'seq'
    | 'actor_id'
    | 'action'
    | 'resource_type'
    | 'resource_id'
    | 'outcome'
    | 'metadata'
  >,
): string {
  return sha256(
    prevHash +
      canonicalJson({
        id: row.id,
        created_at: row.created_at.toISOString(),
        seq: row.seq,
        actor_id: row.actor_id,
        action: row.action,
        resource_type: row.resource_type,
        resource_id: row.resource_id,
        outcome: row.outcome,
        metadata: row.metadata,
      }),
  );
}

export async function recordAudit(trx: PoolClient, entry: AuditEntry): Promise<void> {
  const id = randomUUID();
  const createdAt = new Date();
  const shard = auditShard(entry.resourceId, entry.actorId);
  const headResult = await trx.query<{ last_seq: string; last_hash: string }>(
    'SELECT last_seq,last_hash FROM audit_chain_heads WHERE chain_shard=$1 FOR UPDATE',
    [shard],
  );
  const head = headResult.rows[0];
  if (!head) throw new Error(`Missing audit chain head for shard ${shard}`);
  const seq = (BigInt(head.last_seq) + 1n).toString();
  const row = {
    id,
    created_at: createdAt,
    seq,
    actor_id: entry.actorId ?? null,
    action: entry.action,
    resource_type: entry.resourceType,
    resource_id: entry.resourceId ?? null,
    outcome: entry.outcome,
    metadata: entry.metadata ?? {},
  };
  const hash = auditHash(head.last_hash, row);
  await trx.query(
    `INSERT INTO audit_logs
      (id,created_at,chain_shard,seq,actor_id,actor_role,action,resource_type,resource_id,outcome,
       ip,user_agent,request_id,metadata,prev_hash,hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      id,
      createdAt,
      shard,
      seq,
      row.actor_id,
      entry.actorRole ?? null,
      entry.action,
      entry.resourceType,
      row.resource_id,
      entry.outcome,
      entry.ip ?? null,
      entry.userAgent ?? null,
      entry.requestId ?? null,
      row.metadata,
      head.last_hash,
      hash,
    ],
  );
  await trx.query('UPDATE audit_chain_heads SET last_seq=$2,last_hash=$3 WHERE chain_shard=$1', [
    shard,
    seq,
    hash,
  ]);
}

export async function inAuditTransaction<T>(work: (trx: PoolClient) => Promise<T>): Promise<T> {
  const trx = await primaryPool.connect();
  try {
    await trx.query('BEGIN');
    const result = await work(trx);
    await trx.query('COMMIT');
    return result;
  } catch (error) {
    await trx.query('ROLLBACK');
    throw error;
  } finally {
    trx.release();
  }
}

export type AuditVerification = { checked: number; valid: boolean; firstBrokenSeq: string | null };
export async function verifyAuditChain(
  trx: PoolClient,
  shard: number,
  from: Date,
  to: Date,
): Promise<AuditVerification> {
  const result = await trx.query<ChainRow>(
    `SELECT id,created_at,chain_shard,seq,actor_id,action,resource_type,resource_id,
            outcome,metadata,prev_hash,hash
       FROM audit_logs
      WHERE chain_shard=$1 AND created_at < $2
      ORDER BY seq`,
    [shard, to],
  );
  let previousHash = EMPTY_HASH;
  let previousSeq = 0n;
  let valid = true;
  let firstBrokenSeq: string | null = null;
  let checked = 0;
  for (const row of result.rows) {
    const seq = BigInt(row.seq);
    if (row.created_at >= from) checked += 1;
    const expected = auditHash(previousHash, row);
    if (row.prev_hash !== previousHash || row.hash !== expected || seq !== previousSeq + 1n) {
      if (valid) firstBrokenSeq = row.seq;
      valid = false;
    }
    previousHash = row.hash;
    previousSeq = seq;
  }
  return { checked, valid, firstBrokenSeq };
}

export { EMPTY_HASH };
