import { randomUUID } from 'node:crypto';
import type { EncryptionService } from '../../common/crypto/encryption.service.js';
import { ForbiddenError } from '../../common/errors/index.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import type { IdempotencyService } from '../idempotency/idempotency.service.js';
import type { BookConsultationInput } from './consultations.schemas.js';
import type { ConsultationsRepository } from './consultations.repository.js';
import type { ConsultationEvent } from './consultation.state-machine.js';

export class ConsultationsService {
  constructor(
    private readonly repository: ConsultationsRepository,
    private readonly idempotency: IdempotencyService,
    private readonly encryption: EncryptionService,
  ) {}

  async book(
    user: AuthUser,
    key: string | undefined,
    input: BookConsultationInput,
  ): Promise<{ status: number; body: Record<string, unknown>; replay: boolean }> {
    if (user.role !== 'PATIENT') throw new ForbiddenError();
    const consultationId = randomUUID();
    const reasonEnc = input.reason
      ? await this.encryption.encrypt(input.reason, `consultations.reason_enc:${consultationId}`)
      : undefined;
    return this.repository.book({
      id: consultationId,
      userId: user.id,
      key,
      path: '/consultations',
      body: input,
      slotId: input.slotId,
      mode: input.mode,
      reasonEnc,
    });
  }

  async list(
    user: AuthUser,
    filters: { status?: string; from?: string; to?: string; limit: number; cursor?: string },
  ): Promise<Record<string, unknown>> {
    if (!['PATIENT', 'DOCTOR'].includes(user.role)) throw new ForbiddenError();
    const result = await this.repository.list(user, filters);
    return {
      data: result.rows.map((row) => ({
        id: row.id,
        status: row.status,
        doctor: { id: row.doctor_id, displayName: row.display_name },
        ...(user.role === 'DOCTOR' ? { patient: { fullName: row.patient_name } } : {}),
        scheduledStart: row.scheduled_start,
        scheduledEnd: row.scheduled_end,
        mode: row.mode,
        feeMinor: row.fee_minor,
        currency: typeof row.currency === 'string' ? row.currency.trim() : row.currency,
      })),
      meta: { limit: filters.limit, nextCursor: result.nextCursor },
    };
  }

  async getById(user: AuthUser, id: string): Promise<Record<string, unknown>> {
    const row = await this.repository.getById(user, id);
    const reasonEnc = row.reason_enc;
    const notesEnc = row.doctor_notes_enc;
    const participant = user.id === row.patient_id || user.id === row.doctor_user_id;
    const start = new Date(row.scheduled_start as string | Date);
    const now = Date.now();
    const canJoin =
      participant &&
      ['CONFIRMED', 'IN_PROGRESS'].includes(String(row.status)) &&
      now >= start.getTime() - 15 * 60_000 &&
      now <= new Date(row.scheduled_end as string | Date).getTime();
    const result: Record<string, unknown> = {
      id: row.id,
      status: row.status,
      doctor: { id: row.doctor_id, displayName: row.display_name },
      patient: { fullName: row.patient_name },
      scheduledStart: row.scheduled_start,
      scheduledEnd: row.scheduled_end,
      mode: row.mode,
      feeMinor: row.fee_minor,
      currency: typeof row.currency === 'string' ? row.currency.trim() : row.currency,
      payment: row.payment_id
        ? {
            id: row.payment_id,
            status: row.payment_status,
            amountMinor: row.amount_minor,
            currency: row.payment_currency,
          }
        : null,
      prescriptions: [],
      ...(canJoin && row.meeting_url ? { meetingUrl: row.meeting_url } : {}),
    };
    if (participant && typeof reasonEnc === 'string') {
      result['reason'] = await this.encryption.decrypt(
        reasonEnc,
        `consultations.reason_enc:${row.id}`,
      );
    }
    if (user.id === row.doctor_user_id && typeof notesEnc === 'string') {
      result['doctorNotes'] = await this.encryption.decrypt(
        notesEnc,
        `consultations.doctor_notes_enc:${id}`,
      );
    }
    return result;
  }

  async change(
    user: AuthUser,
    id: string,
    event: ConsultationEvent,
    options: {
      reason?: string;
      notes?: string;
      idempotencyKey?: string;
      requestBody?: unknown;
    } = {},
  ): Promise<{ body: Record<string, unknown>; replay: boolean }> {
    const notesEnc = options.notes
      ? await this.encryption.encrypt(options.notes, `consultations.doctor_notes_enc:${id}`)
      : undefined;
    const result = await this.repository.changeState(user, id, event, {
      reason: options.reason,
      notesEnc,
      idempotencyKey: options.idempotencyKey,
      requestBody: options.requestBody,
    });
    const value = result.value;
    if (result.replay) return { body: value, replay: true };
    const output: Record<string, unknown> = { id: value.id, status: value.status };
    if (value.started_at) output['startedAt'] = value.started_at;
    if (value.completed_at) output['completedAt'] = value.completed_at;
    if (value.refund) output['refund'] = value.refund;
    return { body: output, replay: false };
  }
}
