import { createHash, timingSafeEqual } from 'node:crypto';

import argon2 from 'argon2';

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function constantTimeEqual(left: string | Buffer, right: string | Buffer): boolean {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  const result = JSON.stringify(sortJson(value));
  if (result === undefined) {
    throw new TypeError('Value cannot be represented as canonical JSON');
  }
  return result;
}

export function hashArgon2id(value: string | Buffer): Promise<string> {
  return argon2.hash(value, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export function verifyArgon2id(hash: string, value: string | Buffer): Promise<boolean> {
  return argon2.verify(hash, value);
}

export const hashPassword = hashArgon2id;
export const verifyPassword = verifyArgon2id;