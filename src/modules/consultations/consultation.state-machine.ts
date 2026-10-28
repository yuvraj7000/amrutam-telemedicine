import { ConflictError, ERROR_CODES } from '../../common/errors/index.js';

export type ConsultationStatus =
  | 'PENDING_PAYMENT'
  | 'CONFIRMED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'NO_SHOW';
export type ConsultationEvent =
  'PAYMENT_SUCCEEDED' | 'PAYMENT_FAILED' | 'EXPIRE' | 'CANCEL' | 'START' | 'COMPLETE' | 'NO_SHOW';
export type ConsultationActor = 'PATIENT' | 'DOCTOR' | 'ADMIN' | 'SYSTEM';

const transitions: Partial<
  Record<ConsultationStatus, Partial<Record<ConsultationEvent, ConsultationStatus>>>
> = {
  PENDING_PAYMENT: {
    PAYMENT_SUCCEEDED: 'CONFIRMED',
    PAYMENT_FAILED: 'CANCELLED',
    EXPIRE: 'EXPIRED',
    CANCEL: 'CANCELLED',
  },
  CONFIRMED: { CANCEL: 'CANCELLED', START: 'IN_PROGRESS', NO_SHOW: 'NO_SHOW' },
  IN_PROGRESS: { COMPLETE: 'COMPLETED' },
};

export function transition(
  current: ConsultationStatus,
  event: ConsultationEvent,
  actor: ConsultationActor,
  now = new Date(),
  scheduledStart?: Date,
  scheduledEnd?: Date,
): ConsultationStatus {
  const allowedActors: Record<ConsultationEvent, ConsultationActor[]> = {
    PAYMENT_SUCCEEDED: ['SYSTEM'],
    PAYMENT_FAILED: ['SYSTEM'],
    EXPIRE: ['SYSTEM'],
    CANCEL: ['PATIENT', 'DOCTOR', 'ADMIN', 'SYSTEM'],
    START: ['DOCTOR'],
    COMPLETE: ['DOCTOR'],
    NO_SHOW: ['DOCTOR'],
  };
  if (!allowedActors[event].includes(actor)) throw new ConflictError(ERROR_CODES.INVALID_STATE);
  if (event === 'START' || event === 'NO_SHOW') {
    if (!scheduledStart) throw new ConflictError(ERROR_CODES.INVALID_STATE);
    const starts = scheduledStart.getTime();
    const ends = scheduledEnd?.getTime() ?? starts;
    if (event === 'START' && (now.getTime() < starts - 10 * 60_000 || now.getTime() > ends)) {
      throw new ConflictError(
        ERROR_CODES.INVALID_STATE,
        'The consultation cannot be started at this time.',
      );
    }
    if (event === 'NO_SHOW' && now.getTime() < starts + 10 * 60_000) {
      throw new ConflictError(
        ERROR_CODES.INVALID_STATE,
        'A no-show can only be recorded ten minutes after the scheduled start.',
      );
    }
  }
  const next = transitions[current]?.[event];
  if (!next) throw new ConflictError(ERROR_CODES.INVALID_STATE);
  return next;
}
