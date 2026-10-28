import { randomUUID } from 'node:crypto';

import { redis } from '../../common/cache/redis.js';
import { env } from '../../config/env.js';
import { primaryPool } from '../../common/db/kysely.js';

export interface RefundRequest {
  idempotencyKey: string;
  paymentId: string;
  amountMinor: number;
  providerPaymentId: string;
  timeoutMs: number;
}

export interface RefundResult {
  refundedMinor: number;
}

export interface RefundGateway {
  refund(request: RefundRequest): Promise<RefundResult>;
}

export interface RefundJob {
  eventId?: string;
  aggregateId?: string;
  payload?: Record<string, unknown>;
}

let gateway: RefundGateway | undefined;

const releaseLockScript =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

async function withPaymentLock<T>(paymentId: string, operation: () => Promise<T>): Promise<T> {
  const key = `worker:refund:${paymentId}`;
  const token = randomUUID();
  let acquired = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await redis.set(key, token, 'PX', 60_000, 'NX')) === 'OK') {
      acquired = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!acquired) throw new Error('Timed out waiting for the payment refund lock');

  try {
    return await operation();
  } finally {
    await redis.eval(releaseLockScript, 1, key, token);
  }
}

export function configureRefundGateway(adapter: RefundGateway): void {
  gateway = adapter;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error(`Refund job is missing a valid ${name}`);
  }
  return value;
}

export async function processRefund(job: RefundJob): Promise<void> {
  const paymentId = requiredString(job.payload?.paymentId ?? job.aggregateId, 'paymentId');
  if (typeof job.eventId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(job.eventId)) {
    throw new Error('Refund job is missing a valid eventId');
  }
  const eventId = job.eventId;
  const amountMinor = job.payload?.amountMinor;
  if (!Number.isSafeInteger(amountMinor) || Number(amountMinor) <= 0) {
    throw new Error('Refund job requires a positive amountMinor');
  }
  await withPaymentLock(paymentId, async () => {
    const paymentResult = await primaryPool.query<{
      id: string;
      amount_minor: number;
      refunded_minor: number;
      status: string;
      provider_payment_id: string | null;
    }>(
      `SELECT id, amount_minor, refunded_minor, status, provider_payment_id
       FROM payments WHERE id = $1`,
      [paymentId],
    );
    const payment = paymentResult.rows[0];
    if (!payment) throw new Error('Refund references a missing payment');
    if (payment.refunded_minor >= payment.amount_minor) return;
    if (!payment.provider_payment_id) throw new Error('Refund payment has no provider reference');
    if (!gateway) throw new Error('Payment refund gateway is not configured');

    const refund = await gateway.refund({
      idempotencyKey: eventId,
      paymentId,
      amountMinor: Math.min(Number(amountMinor), payment.amount_minor - payment.refunded_minor),
      providerPaymentId: payment.provider_payment_id,
      timeoutMs: env.PAYMENT_TIMEOUT_MS,
    });
    if (
      !Number.isSafeInteger(refund.refundedMinor) ||
      refund.refundedMinor < payment.refunded_minor ||
      refund.refundedMinor > payment.amount_minor
    ) {
      throw new Error('Payment gateway returned an invalid cumulative refunded amount');
    }

    await primaryPool.query(
      `UPDATE payments
       SET refunded_minor = GREATEST(refunded_minor, $2),
           status = CASE
             WHEN GREATEST(refunded_minor, $2) >= amount_minor THEN 'REFUNDED'::payment_status
             WHEN GREATEST(refunded_minor, $2) > 0 THEN 'PARTIALLY_REFUNDED'::payment_status
             ELSE status
           END,
           version = version + 1
       WHERE id = $1`,
      [paymentId, refund.refundedMinor],
    );
  });
}
