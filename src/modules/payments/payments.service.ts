import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AppError,
  ERROR_CODES,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../common/errors/index.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import { env } from '../../config/env.js';
import { webhookSignatureFailures } from '../../common/observability/metrics.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { MockPaymentGateway } from './gateway/mock-gateway.js';
import type { PaymentGateway, PaymentWebhook } from './gateway/payment-gateway.js';
import { PaymentsRepository } from './payments.repository.js';

export class PaymentsService {
  constructor(
    private readonly repository: PaymentsRepository,
    private readonly gateway: PaymentGateway,
    private readonly secret: string,
  ) {}

  async getById(user: AuthUser, id: string): Promise<Record<string, unknown>> {
    const row = await this.repository.getById(user, id);
    const owner = row.patient_id === user.id;
    return {
      id: row.id,
      consultationId: row.consultation_id,
      status: row.status,
      amountMinor: row.amount_minor,
      currency: typeof row.currency === 'string' ? row.currency.trim() : row.currency,
      ...(owner && row.status === 'PENDING' ? { clientSecret: row.client_secret } : {}),
      expiresAt: row.expires_at,
    };
  }

  async refund(
    user: AuthUser,
    id: string,
    input: { amountMinor?: number; reason: string },
    key?: string,
  ): Promise<void> {
    if (user.role !== 'ADMIN') throw new ForbiddenError();
    await this.repository.refund(user, id, input.amountMinor, input.reason, key);
  }

  async verifyAndApply(rawBody: Buffer, signature: string | undefined): Promise<void> {
    this.verify(rawBody, signature);
    let event: PaymentWebhook;
    try {
      event = JSON.parse(rawBody.toString('utf8')) as PaymentWebhook;
    } catch {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 400, 'Webhook body is malformed.');
    }
    if (!isWebhook(event))
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 400, 'Webhook body is malformed.');
    await this.repository.applyWebhook(event);
  }

  async simulate(user: AuthUser, id: string, outcome: 'succeeded' | 'failed'): Promise<void> {
    if (env.NODE_ENV === 'production') throw new NotFoundError();
    const payment = await this.repository.getForSimulation(user, id);
    const event: PaymentWebhook = {
      id: `evt_${id}_${outcome}`,
      type: outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
      data: {
        paymentId: id,
        amountMinor: Number(payment.amount_minor),
        ...(outcome === 'failed' ? { reason: 'Simulated failure' } : {}),
      },
    };
    const signed = this.gateway.createWebhook(event);
    await this.verifyAndApply(signed.rawBody, signed.signature);
  }

  async createIntent(paymentId: string, amountMinor: number, currency: string): Promise<void> {
    const intent = await this.gateway.createPaymentIntent(paymentId, amountMinor, currency);
    await this.repository.setIntent(paymentId, intent.providerPaymentId, intent.clientSecret);
  }

  private verify(rawBody: Buffer, signature: string | undefined): void {
    const match = signature?.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    if (!match) throw this.invalidSignature();
    const timestamp = Number(match[1]);
    if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) {
      throw this.invalidSignature('Webhook timestamp is outside the allowed window.');
    }
    const expected = createHmac('sha256', this.secret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest();
    const received = Buffer.from(match[2]!, 'hex');
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw this.invalidSignature();
    }
  }

  private invalidSignature(detail = 'Webhook signature is invalid.'): UnauthorizedError {
    webhookSignatureFailures.inc();
    return new UnauthorizedError(ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, detail);
  }
}

function isWebhook(value: unknown): value is PaymentWebhook {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<PaymentWebhook>;
  return (
    typeof event.id === 'string' &&
    event.id.length > 0 &&
    ['payment.succeeded', 'payment.failed', 'refund.succeeded'].includes(String(event.type)) &&
    !!event.data &&
    typeof event.data.paymentId === 'string' &&
    Number.isSafeInteger(event.data.amountMinor) &&
    event.data.amountMinor >= 0
  );
}

export function createPaymentsDependencies(): {
  service: PaymentsService;
  idempotency: IdempotencyService;
} {
  if (env.PAYMENT_PROVIDER !== 'mock') {
    throw new Error(
      `The ${env.PAYMENT_PROVIDER} payment adapter is not configured in this application.`,
    );
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('The mock payment provider cannot be used in production.');
  }
  const idempotency = new IdempotencyService(undefined, env.IDEMPOTENCY_TTL_HOURS);
  return {
    idempotency,
    service: new PaymentsService(
      new PaymentsRepository(idempotency),
      new MockPaymentGateway(env.PAYMENT_WEBHOOK_SECRET),
      env.PAYMENT_WEBHOOK_SECRET,
    ),
  };
}
