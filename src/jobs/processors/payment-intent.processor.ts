import { primaryPool } from '../../common/db/kysely.js';
import { env } from '../../config/env.js';

export interface PaymentIntentRequest {
  idempotencyKey: string;
  paymentId: string;
  amountMinor: number;
  currency: string;
  consultationId: string;
  patientId: string;
  timeoutMs: number;
}

export interface PaymentIntentResult {
  providerPaymentId: string;
  clientSecret?: string;
}

export interface PaymentIntentGateway {
  createIntent(request: PaymentIntentRequest): Promise<PaymentIntentResult>;
}

export interface PaymentIntentJob {
  eventId?: string;
  aggregateId?: string;
  payload?: Record<string, unknown>;
}

let gateway: PaymentIntentGateway | undefined;

export function configurePaymentIntentGateway(adapter: PaymentIntentGateway): void {
  gateway = adapter;
}

function requiredId(value: unknown, name: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error(`Payment intent job is missing a valid ${name}`);
  }
  return value;
}

export async function processPaymentIntent(job: PaymentIntentJob): Promise<void> {
  const paymentId = requiredId(job.payload?.paymentId ?? job.aggregateId, 'paymentId');
  const result = await primaryPool.query<{
    id: string;
    consultation_id: string;
    patient_id: string;
    amount_minor: number;
    currency: string;
    status: string;
    provider_payment_id: string | null;
  }>(
    `SELECT id, consultation_id, patient_id, amount_minor, currency, status, provider_payment_id
     FROM payments WHERE id = $1`,
    [paymentId],
  );
  const payment = result.rows[0];
  if (!payment) throw new Error('Payment intent references a missing payment');
  if (payment.status !== 'INITIATED') return;
  if (!gateway) throw new Error('Payment intent gateway is not configured');

  const intent = await gateway.createIntent({
    idempotencyKey: payment.id,
    paymentId: payment.id,
    amountMinor: payment.amount_minor,
    currency: payment.currency,
    consultationId: payment.consultation_id,
    patientId: payment.patient_id,
    timeoutMs: env.PAYMENT_TIMEOUT_MS,
  });
  if (!intent.providerPaymentId) throw new Error('Payment gateway returned no payment reference');

  await primaryPool.query(
    `UPDATE payments
     SET status = 'PENDING',
         provider_payment_id = COALESCE(provider_payment_id, $2),
         client_secret = COALESCE(client_secret, $3),
         version = version + 1
     WHERE id = $1 AND status = 'INITIATED'`,
    [payment.id, intent.providerPaymentId, intent.clientSecret ?? null],
  );
}
