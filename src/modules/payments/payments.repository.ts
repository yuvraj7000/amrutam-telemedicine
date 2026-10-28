import { primaryPool } from '../../common/db/kysely.js';
import {
  ConflictError,
  ERROR_CODES,
  ForbiddenError,
  NotFoundError,
} from '../../common/errors/index.js';
import { recordAudit } from '../audit/hash-chain.js';
import type { IdempotencyService } from '../idempotency/idempotency.service.js';
import type { PaymentWebhook } from './gateway/payment-gateway.js';

export class PaymentsRepository {
  constructor(private readonly idempotency?: IdempotencyService) {}
  async getById(user: { id: string; role: string }, id: string): Promise<Record<string, unknown>> {
    const result = await primaryPool.query<Record<string, unknown>>(
      `SELECT p.id,p.consultation_id,p.patient_id,p.amount_minor,p.refunded_minor,p.currency,p.status,
       p.client_secret,p.created_at,c.expires_at
       FROM payments p JOIN consultations c ON c.id=p.consultation_id
       WHERE p.id=$1 AND (p.patient_id=$2 OR $3='ADMIN')`,
      [id, user.id, user.role],
    );
    if (!result.rows[0]) {
      const exists = await primaryPool.query('SELECT id FROM payments WHERE id=$1', [id]);
      if (exists.rows[0]) throw new ForbiddenError();
      throw new NotFoundError();
    }
    return result.rows[0];
  }

  async getForSimulation(
    user: { id: string; role: string },
    id: string,
  ): Promise<Record<string, unknown>> {
    const result = await primaryPool.query<Record<string, unknown>>(
      "SELECT id,patient_id,amount_minor,currency,status FROM payments WHERE id=$1 AND (patient_id=$2 OR $3='ADMIN')",
      [id, user.id, user.role],
    );
    if (!result.rows[0]) throw new NotFoundError();
    return result.rows[0];
  }

  async refund(
    user: { id: string; role: string },
    id: string,
    amount: number | undefined,
    reason: string,
    key: string | undefined,
  ): Promise<{ replay: boolean }> {
    const client = await primaryPool.connect();
    try {
      await client.query('BEGIN');
      if (!this.idempotency)
        throw new Error('Idempotency service is required for refund requests.');
      const request = { amountMinor: amount, reason };
      const idem = await this.idempotency.begin(
        client,
        user.id,
        key,
        'POST',
        `/payments/${id}/refund`,
        request,
      );
      if (idem.replay) {
        await client.query('COMMIT');
        return { replay: true };
      }
      const result = await client.query<{
        id: string;
        amount_minor: number;
        refunded_minor: number;
        status: string;
      }>('SELECT id,amount_minor,refunded_minor,status FROM payments WHERE id=$1 FOR UPDATE', [id]);
      const payment = result.rows[0];
      if (!payment) throw new NotFoundError();
      const refundAmount = amount ?? Number(payment.amount_minor) - Number(payment.refunded_minor);
      if (
        refundAmount <= 0 ||
        refundAmount > Number(payment.amount_minor) - Number(payment.refunded_minor)
      ) {
        throw new ConflictError(
          ERROR_CODES.INVALID_STATE,
          'Refund amount exceeds the remaining captured amount.',
        );
      }
      if (payment.status !== 'SUCCEEDED' && payment.status !== 'PARTIALLY_REFUNDED') {
        throw new ConflictError(
          ERROR_CODES.INVALID_STATE,
          'Only captured payments can be refunded.',
        );
      }
      await client.query(
        `INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload)
         VALUES ('payment',$1,'refund.requested',$2::jsonb)`,
        [
          id,
          JSON.stringify({
            paymentId: id,
            amountMinor: refundAmount,
            reason,
            requestedBy: user.id,
          }),
        ],
      );
      await recordAudit(client, {
        actorId: user.id,
        actorRole: 'ADMIN',
        action: 'payment.refund.request',
        resourceType: 'payment',
        resourceId: id,
        outcome: 'SUCCESS',
        metadata: { amountMinor: refundAmount, reason },
      });
      await this.idempotency.complete(client, user.id, key!, 202, { status: 'REFUND_PENDING' });
      await client.query('COMMIT');
      return { replay: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async applyWebhook(event: PaymentWebhook): Promise<void> {
    const client = await primaryPool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO payment_events (provider_event_id,event_type,payload)
         VALUES ($1,$2,$3::jsonb) ON CONFLICT (provider_event_id) DO NOTHING RETURNING id`,
        [event.id, event.type, JSON.stringify(event)],
      );
      if (!inserted.rows[0]) {
        await client.query('COMMIT');
        return;
      }
      const found = await client.query<{
        id: string;
        consultation_id: string;
        patient_id: string;
        status: string;
        amount_minor: number;
        refunded_minor: number;
      }>(
        `SELECT id,consultation_id,patient_id,status,amount_minor,refunded_minor FROM payments
         WHERE provider_payment_id=$1 OR id::text=$1 FOR UPDATE`,
        [event.data.paymentId],
      );
      const payment = found.rows[0];
      if (!payment) throw new NotFoundError('Payment associated with webhook was not found.');
      if (event.type === 'payment.succeeded') {
        if (Number(payment.amount_minor) !== event.data.amountMinor)
          throw new ConflictError(
            ERROR_CODES.WEBHOOK_SIGNATURE_INVALID,
            'Payment amount does not match.',
          );
        await client.query(
          `UPDATE payments SET status='SUCCEEDED',version=version+1 WHERE id=$1 AND status IN ('INITIATED','PENDING','FAILED')`,
          [payment.id],
        );
        const consultation = await client.query<{ id: string; status: string; slot_id: string }>(
          'SELECT id,status,slot_id FROM consultations WHERE id=$1 FOR UPDATE',
          [payment.consultation_id],
        );
        if (consultation.rows[0]?.status === 'PENDING_PAYMENT') {
          await client.query(
            `UPDATE consultations SET status='CONFIRMED',version=version+1 WHERE id=$1 AND status='PENDING_PAYMENT'`,
            [payment.consultation_id],
          );
          await client.query(
            `UPDATE availability_slots SET status='BOOKED',held_until=NULL,version=version+1 WHERE id=$1 AND status='HELD'`,
            [consultation.rows[0].slot_id],
          );
        } else if (
          consultation.rows[0] &&
          ['EXPIRED', 'CANCELLED'].includes(consultation.rows[0].status)
        ) {
          const reclaimed = await client.query(
            `UPDATE availability_slots SET status='BOOKED',held_by=$2,held_until=NULL,version=version+1
             WHERE id=$1 AND (status='AVAILABLE' OR (status='HELD' AND held_until<now()))`,
            [consultation.rows[0].slot_id, payment.patient_id],
          );
          if ((reclaimed.rowCount ?? 0) > 0) {
            await client.query(
              `UPDATE consultations SET status='CONFIRMED',cancelled_at=NULL,cancelled_by=NULL,cancel_reason=NULL,version=version+1 WHERE id=$1`,
              [payment.consultation_id],
            );
          } else {
            await client.query(
              `INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload) VALUES ('payment',$1,'refund.requested',$2::jsonb)`,
              [
                payment.id,
                JSON.stringify({
                  paymentId: payment.id,
                  amountMinor: event.data.amountMinor,
                  reason: 'late_payment_slot_unavailable',
                }),
              ],
            );
          }
        }
      } else if (event.type === 'payment.failed') {
        await client.query(
          `UPDATE payments SET status='FAILED',failure_reason=$2,version=version+1 WHERE id=$1 AND status IN ('INITIATED','PENDING')`,
          [payment.id, event.data.reason ?? 'Payment failed'],
        );
        const consultation = await client.query<{ id: string; status: string; slot_id: string }>(
          'SELECT id,status,slot_id FROM consultations WHERE id=$1 FOR UPDATE',
          [payment.consultation_id],
        );
        if (consultation.rows[0]?.status === 'PENDING_PAYMENT') {
          await client.query(
            `UPDATE consultations SET status='CANCELLED',cancelled_at=now(),cancel_reason='PAYMENT_FAILED',version=version+1 WHERE id=$1`,
            [payment.consultation_id],
          );
          await client.query(
            `UPDATE availability_slots SET status=CASE WHEN start_time>now() THEN 'AVAILABLE'::slot_status ELSE 'CANCELLED'::slot_status,held_by=NULL,held_until=NULL,version=version+1 WHERE id=$1 AND status='HELD'`,
            [consultation.rows[0].slot_id],
          );
        }
      } else {
        const refund = event.data.amountMinor;
        const newRefunded = Number(payment.refunded_minor) + refund;
        if (refund <= 0 || newRefunded > Number(payment.amount_minor))
          throw new ConflictError(
            ERROR_CODES.INVALID_STATE,
            'Refund total exceeds payment amount.',
          );
        await client.query(
          `UPDATE payments SET refunded_minor=$2,status=CASE WHEN $2=amount_minor THEN 'REFUNDED'::payment_status ELSE 'PARTIALLY_REFUNDED'::payment_status END,version=version+1 WHERE id=$1`,
          [payment.id, newRefunded],
        );
      }
      await recordAudit(client, {
        actorRole: 'PROVIDER',
        action: event.type,
        resourceType: 'payment',
        resourceId: payment.id,
        outcome: 'SUCCESS',
        metadata: { providerEventId: event.id },
      });
      await client.query(
        'UPDATE payment_events SET processed_at=now() WHERE provider_event_id=$1',
        [event.id],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setIntent(paymentId: string, providerId: string, clientSecret: string): Promise<void> {
    await primaryPool.query(
      `UPDATE payments SET provider_payment_id=$2,client_secret=$3,status='PENDING',version=version+1
       WHERE id=$1 AND status='INITIATED'`,
      [paymentId, providerId, clientSecret],
    );
  }
}
