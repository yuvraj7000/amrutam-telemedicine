import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../../common/crypto/hash.js';
import { AppError, ConflictError, ERROR_CODES } from '../../common/errors/index.js';
import { IdempotencyRepository } from './idempotency.repository.js';

export type IdempotencyResult<T> = { replay: true; status: number; body: T } | { replay: false };

export class IdempotencyService {
  constructor(
    private readonly repository = new IdempotencyRepository(),
    private readonly ttlHours = 24,
  ) {}

  hash(method: string, path: string, body: unknown): string {
    return createHash('sha256')
      .update(`${method.toUpperCase()}\n${path}\n${canonicalJson(body)}`)
      .digest('hex');
  }

  async begin(
    client: PoolClient,
    userId: string,
    key: string | undefined,
    method: string,
    path: string,
    body: unknown,
  ): Promise<IdempotencyResult<unknown> & { key?: string }> {
    if (!key || key.length < 8 || key.length > 128) {
      throw new AppError(
        ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED,
        422,
        'A valid Idempotency-Key header is required.',
      );
    }
    const requestHash = this.hash(method, path, body);
    const result = await this.repository.begin(client, {
      userId,
      key,
      requestHash,
      method: method.toUpperCase(),
      path,
      ttlHours: this.ttlHours,
    });
    if (result.inserted) return { replay: false, key };
    if (result.record.request_hash !== requestHash) {
      throw new AppError(
        ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
        422,
        ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
      );
    }
    if (result.record.response_status === null) {
      throw new ConflictError(
        ERROR_CODES.CONCURRENT_MODIFICATION,
        'The idempotent request is not yet complete.',
      );
    }
    return {
      replay: true,
      status: result.record.response_status,
      body: result.record.response_body,
      key,
    };
  }

  complete(
    client: PoolClient,
    userId: string,
    key: string,
    status: number,
    body: unknown,
  ): Promise<void> {
    return this.repository.complete(client, userId, key, status, body);
  }
}
