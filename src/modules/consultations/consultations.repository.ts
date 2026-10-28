import type { PoolClient } from 'pg';
import { primaryPool } from '../../common/db/kysely.js';
import {
  AppError,
  ConflictError,
  ERROR_CODES,
  ForbiddenError,
  NotFoundError,
} from '../../common/errors/index.js';
import { env } from '../../config/env.js';
import { recordAudit } from '../audit/hash-chain.js';
import type { IdempotencyService } from '../idempotency/idempotency.service.js';
import type { ConsultationEvent, ConsultationStatus } from './consultation.state-machine.js';
import { transition } from './consultation.state-machine.js';

export type ConsultationRow = Record<string, unknown> & {
  id: string;
  patient_id: string;
  doctor_id: string;
  status: ConsultationStatus;
  scheduled_start: Date;
  scheduled_end: Date;
  version: number;
};

export class ConsultationsRepository {
  constructor(private readonly idempotency: IdempotencyService) {}

  async book(input: {
    id: string;
    userId: string;
    key?: string;
    path: string;
    body: unknown;
    slotId: string;
    mode: string;
    reasonEnc?: string;
  }): Promise<{ status: number; body: Record<string, unknown>; replay: boolean }> {
    const client = await primaryPool.connect();
    try {
      await client.query('BEGIN');
      const idem = await this.idempotency.begin(
        client,
        input.userId,
        input.key,
        'POST',
        input.path,
        input.body,
      );
      if (idem.replay) {
        await client.query('COMMIT');
        return { status: idem.status, body: idem.body as Record<string, unknown>, replay: true };
      }
      const slot = await client.query<{
        id: string;
        doctor_id: string;
        start_time: Date;
        end_time: Date;
      }>(
        `UPDATE availability_slots SET status='HELD',held_by=$2,
          held_until=now()+($3::text || ' minutes')::interval,version=version+1
         WHERE id=$1 AND start_time > now()+($4::text || ' minutes')::interval
           AND (status='AVAILABLE' OR (status='HELD' AND held_until<now()))
         RETURNING id,doctor_id,start_time,end_time`,
        [input.slotId, input.userId, env.SLOT_HOLD_MINUTES, env.MIN_BOOKING_LEAD_MINUTES],
      );
      if (!slot.rows[0]) {
        const found = await client.query<{ start_time: Date }>(
          'SELECT id,start_time FROM availability_slots WHERE id=$1',
          [input.slotId],
        );
        if (!found.rows[0]) throw new NotFoundError('Availability slot was not found.');
        if (
          found.rows[0].start_time.getTime() <=
          Date.now() + env.MIN_BOOKING_LEAD_MINUTES * 60_000
        ) {
          throw new AppError(ERROR_CODES.SLOT_TOO_SOON, 422, ERROR_CODES.SLOT_TOO_SOON);
        }
        throw new ConflictError(ERROR_CODES.SLOT_UNAVAILABLE);
      }
      const selectedSlot = slot.rows[0];
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [input.userId]);
      const overlapping = await client.query(
        `SELECT id FROM consultations WHERE patient_id=$1
         AND (status IN ('CONFIRMED','IN_PROGRESS') OR (status='PENDING_PAYMENT' AND expires_at>now()))
         AND scheduled_start < $3 AND scheduled_end > $2 LIMIT 1`,
        [input.userId, selectedSlot.start_time, selectedSlot.end_time],
      );
      if (overlapping.rows[0]) throw new ConflictError(ERROR_CODES.PATIENT_DOUBLE_BOOKED);
      const doctor = await client.query<{
        consultation_fee_minor: number;
        currency: string;
        modes: string[];
        verification_status: string;
        is_accepting: boolean;
      }>(
        `SELECT consultation_fee_minor,currency,modes,verification_status,is_accepting FROM doctors WHERE id=$1 FOR SHARE`,
        [selectedSlot.doctor_id],
      );
      const doctorRow = doctor.rows[0];
      if (
        !doctorRow ||
        doctorRow.verification_status !== 'VERIFIED' ||
        !doctorRow.is_accepting ||
        !doctorRow.modes.includes(input.mode)
      )
        throw new ConflictError(ERROR_CODES.SLOT_UNAVAILABLE);
      const created = await client.query<ConsultationRow>(
        `INSERT INTO consultations (id,patient_id,doctor_id,slot_id,status,mode,scheduled_start,scheduled_end,fee_minor,currency,reason_enc,expires_at)
         VALUES ($1,$2,$3,$4,'PENDING_PAYMENT',$5,$6,$7,$8,$9,$10,now()+($11::text || ' minutes')::interval)
         RETURNING *`,
        [
          input.id,
          input.userId,
          selectedSlot.doctor_id,
          selectedSlot.id,
          input.mode,
          selectedSlot.start_time,
          selectedSlot.end_time,
          doctorRow.consultation_fee_minor,
          doctorRow.currency,
          input.reasonEnc ?? null,
          env.SLOT_HOLD_MINUTES,
        ],
      );
      const consultation = created.rows[0]!;
      const payment = await client.query<{ id: string; status: string }>(
        `INSERT INTO payments (consultation_id,patient_id,amount_minor,currency,status,provider)
         VALUES ($1,$2,$3,$4,'INITIATED',$5) RETURNING id,status`,
        [
          consultation.id,
          input.userId,
          doctorRow.consultation_fee_minor,
          doctorRow.currency,
          env.PAYMENT_PROVIDER,
        ],
      );
      const paymentRow = payment.rows[0]!;
      const response = {
        id: consultation.id,
        status: consultation.status,
        doctorId: consultation.doctor_id,
        slotId: consultation.slot_id,
        scheduledStart: consultation.scheduled_start,
        scheduledEnd: consultation.scheduled_end,
        feeMinor: consultation.fee_minor,
        currency: consultation.currency,
        expiresAt: consultation.expires_at,
        payment: {
          id: paymentRow.id,
          status: paymentRow.status,
          pollUrl: `/api/v1/payments/${paymentRow.id}`,
        },
      };
      await writeAudit(
        client,
        input.userId,
        'PATIENT',
        'consultation.book',
        'consultation',
        consultation.id,
      );
      await client.query(
        `INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload)
         VALUES ('payment',$1,'payment.intent.requested',$2::jsonb)`,
        [
          paymentRow.id,
          JSON.stringify({ paymentId: paymentRow.id, consultationId: consultation.id }),
        ],
      );
      await this.idempotency.complete(client, input.userId, input.key!, 201, response);
      await client.query('COMMIT');
      return { status: 201, body: response, replay: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async list(
    user: { id: string; role: string },
    filters: { status?: string; from?: string; to?: string; limit: number; cursor?: string },
  ): Promise<{ rows: Record<string, unknown>[]; nextCursor: string | null }> {
    const values: unknown[] = [user.id];
    const owner = user.role === 'DOCTOR' ? 'd.user_id' : 'c.patient_id';
    const clauses = [`${owner}=$1`];
    if (filters.status) clauses.push(`c.status=$${values.push(filters.status)}`);
    if (filters.from) clauses.push(`c.scheduled_start >= $${values.push(filters.from)}`);
    if (filters.to) clauses.push(`c.scheduled_start < $${values.push(filters.to)}`);
    const cursor = parseCursor(filters.cursor);
    if (cursor) {
      clauses.push(
        `(c.scheduled_start,c.id)<($${values.push(cursor.scheduledStart)}::timestamptz,$${values.push(cursor.id)}::uuid)`,
      );
    }
    values.push(filters.limit + 1);
    const result = await primaryPool.query<Record<string, unknown>>(
      `SELECT c.id,c.status,c.scheduled_start,c.scheduled_end,c.mode,c.fee_minor,c.currency,
       d.id AS doctor_id,d.display_name,p.full_name AS patient_name
       FROM consultations c JOIN doctors d ON d.id=c.doctor_id JOIN profiles p ON p.user_id=c.patient_id
       WHERE ${clauses.join(' AND ')} ORDER BY c.scheduled_start DESC,c.id DESC LIMIT $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > filters.limit;
    const rows = result.rows.slice(0, filters.limit);
    const last = rows[rows.length - 1];
    return {
      rows,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                scheduledStart: new Date(last.scheduled_start as string | Date).toISOString(),
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    };
  }

  async getById(user: { id: string; role: string }, id: string): Promise<Record<string, unknown>> {
    const client = await primaryPool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<Record<string, unknown>>(
        `SELECT c.*,d.user_id AS doctor_user_id,d.display_name,p.full_name AS patient_name,
       pay.id AS payment_id,pay.status AS payment_status,pay.amount_minor,pay.refunded_minor,
       pay.currency AS payment_currency
       FROM consultations c JOIN doctors d ON d.id=c.doctor_id
       JOIN profiles p ON p.user_id=c.patient_id
       LEFT JOIN payments pay ON pay.consultation_id=c.id
       WHERE c.id=$1 AND (c.patient_id=$2 OR d.user_id=$2 OR $3='ADMIN')`,
        [id, user.id, user.role],
      );
      const row = result.rows[0];
      if (!row) throw new NotFoundError();
      await writeAudit(client, user.id, user.role, 'consultation.read', 'consultation', id);
      await client.query('COMMIT');
      return row;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async changeState(
    user: { id: string; role: string },
    id: string,
    event: ConsultationEvent,
    options: {
      reason?: string;
      notesEnc?: string;
      idempotencyKey?: string;
      requestBody?: unknown;
    } = {},
  ): Promise<{ value: Record<string, unknown>; replay: boolean }> {
    const client = await primaryPool.connect();
    try {
      await client.query('BEGIN');
      if (event === 'CANCEL') {
        const idem = await this.idempotency.begin(
          client,
          user.id,
          options.idempotencyKey,
          'POST',
          `/consultations/${id}/cancel`,
          options.requestBody ?? { reason: options.reason },
        );
        if (idem.replay) {
          await client.query('COMMIT');
          return { value: idem.body as Record<string, unknown>, replay: true };
        }
      }
      const selected = await client.query<ConsultationRow & { doctor_user_id: string }>(
        `SELECT c.*,d.user_id AS doctor_user_id FROM consultations c JOIN doctors d ON d.id=c.doctor_id WHERE c.id=$1 FOR UPDATE OF c`,
        [id],
      );
      const row = selected.rows[0];
      if (!row) throw new NotFoundError();
      const actor = user.role === 'ADMIN' ? 'ADMIN' : (user.role as 'PATIENT' | 'DOCTOR');
      if (
        (actor === 'PATIENT' && row.patient_id !== user.id) ||
        (actor === 'DOCTOR' && row.doctor_user_id !== user.id)
      )
        throw new ForbiddenError();
      const next = transition(
        row.status,
        event,
        actor,
        new Date(),
        row.scheduled_start,
        row.scheduled_end,
      );
      if (event === 'CANCEL' && Date.now() >= row.scheduled_start.getTime()) {
        throw new ConflictError(ERROR_CODES.TOO_LATE_TO_CANCEL);
      }
      let refundMinor = 0;
      if (event === 'CANCEL') {
        const refundPct =
          actor !== 'PATIENT' ||
          row.scheduled_start.getTime() - Date.now() >= env.CANCEL_FULL_REFUND_HOURS * 3_600_000
            ? 100
            : 50;
        const amount = Number(row.fee_minor);
        refundMinor = Math.floor((amount * refundPct) / 100);
      }
      const update = await client.query<ConsultationRow>(
        `UPDATE consultations SET status=$2,version=version+1,
         started_at=CASE WHEN $2='IN_PROGRESS' THEN now() ELSE started_at END,
         completed_at=CASE WHEN $2='COMPLETED' THEN now() ELSE completed_at END,
         cancelled_at=CASE WHEN $2='CANCELLED' THEN now() ELSE cancelled_at END,
         cancelled_by=CASE WHEN $2='CANCELLED' THEN $3 ELSE cancelled_by END,
         cancel_reason=CASE WHEN $2='CANCELLED' THEN $4 ELSE cancel_reason END,
         doctor_notes_enc=COALESCE($5,doctor_notes_enc)
         WHERE id=$1 AND version=$6 AND status=$7 RETURNING *`,
        [
          id,
          next,
          user.id,
          options.reason ?? null,
          options.notesEnc ?? null,
          row.version,
          row.status,
        ],
      );
      if (!update.rows[0]) throw new ConflictError(ERROR_CODES.CONCURRENT_MODIFICATION);
      if (event === 'CANCEL' || event === 'PAYMENT_FAILED' || event === 'EXPIRE') {
        await client.query(
          `UPDATE availability_slots SET status=CASE WHEN start_time>now() THEN 'AVAILABLE'::slot_status ELSE 'CANCELLED'::slot_status,
           held_by=NULL,held_until=NULL,version=version+1 WHERE id=$1 AND status IN ('HELD','BOOKED')`,
          [row.slot_id],
        );
      } else if (event === 'PAYMENT_SUCCEEDED') {
        await client.query(
          `UPDATE availability_slots SET status='BOOKED',held_until=NULL,version=version+1 WHERE id=$1 AND status='HELD'`,
          [row.slot_id],
        );
      }
      if (event === 'CANCEL' && refundMinor > 0) {
        const payment = await client.query<{ id: string; status: string }>(
          'SELECT id,status FROM payments WHERE consultation_id=$1 ORDER BY created_at DESC LIMIT 1',
          [id],
        );
        if (
          payment.rows[0] &&
          ['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(payment.rows[0].status)
        ) {
          await client.query(
            `INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,payload)
             VALUES ('payment',$1,'refund.requested',$2::jsonb)`,
            [
              payment.rows[0].id,
              JSON.stringify({ paymentId: payment.rows[0].id, amountMinor: refundMinor }),
            ],
          );
        } else refundMinor = 0;
      }
      await writeAudit(
        client,
        user.id,
        actor,
        `consultation.${event.toLowerCase()}`,
        'consultation',
        id,
      );
      const value = {
        ...update.rows[0],
        ...(event === 'CANCEL'
          ? {
              refund: {
                status: refundMinor ? 'PENDING' : 'NOT_APPLICABLE',
                amountMinor: refundMinor,
              },
            }
          : {}),
      };
      if (event === 'CANCEL')
        await this.idempotency.complete(client, user.id, options.idempotencyKey!, 200, {
          id: value.id,
          status: value.status,
          refund: value.refund,
        });
      await client.query('COMMIT');
      return { value, replay: false };
    } catch (error) {
      await client.query('ROLLBACK');
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }
}

async function writeAudit(
  client: PoolClient,
  actorId: string,
  actorRole: string,
  action: string,
  resourceType: string,
  resourceId: string,
): Promise<void> {
  await recordAudit(client, {
    actorId,
    actorRole,
    action,
    resourceType,
    resourceId,
    outcome: 'SUCCESS',
  });
}

function mapDatabaseError(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === '23P01' || error.code === '23505')
      return new ConflictError(ERROR_CODES.SLOT_UNAVAILABLE);
  }
  return error;
}
function parseCursor(cursor?: string): { scheduledStart: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
    if (typeof value === 'object' && value !== null && 'scheduledStart' in value && 'id' in value) {
      const parsed = value as Record<string, unknown>;
      if (
        typeof parsed.scheduledStart === 'string' &&
        !Number.isNaN(Date.parse(parsed.scheduledStart)) &&
        typeof parsed.id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(parsed.id)
      ) {
        return { scheduledStart: parsed.scheduledStart, id: parsed.id };
      }
    }
  } catch {
    /* Invalid cursor starts a new listing. */
  }
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 422, 'Invalid cursor.');
}
