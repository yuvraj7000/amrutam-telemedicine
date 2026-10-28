import { ERROR_CODES, AppError } from '../../src/common/errors/index.js';
import { IdempotencyService } from '../../src/modules/idempotency/idempotency.service.js';
import { ConsultationsService } from '../../src/modules/consultations/consultations.service.js';
import { transition } from '../../src/modules/consultations/consultation.state-machine.js';
import { bookConsultationSchema } from '../../src/modules/consultations/consultations.schemas.js';
import { MockPaymentGateway } from '../../src/modules/payments/gateway/mock-gateway.js';
import type { PaymentWebhook } from '../../src/modules/payments/gateway/payment-gateway.js';
import { PaymentsService } from '../../src/modules/payments/payments.service.js';
import { DoctorsService } from '../../src/modules/doctors/doctors.service.js';
import { doctorSearchSchema } from '../../src/modules/doctors/doctors.schemas.js';

describe('core API domain behavior', () => {
  it('includes verification status for admin doctor searches only', async () => {
    const repository = {
      search: jest.fn(async () => ({
        rows: [
          {
            id: 'doctor-profile-id',
            display_name: 'Dr Pending',
            verification_status: 'PENDING',
            specializations: ['general-medicine'],
            languages: ['en'],
            years_experience: 2,
            consultation_fee_minor: 50000,
            currency: 'INR',
            modes: ['VIDEO'],
            rating_avg: 0,
            rating_count: 0,
            is_accepting: true,
          },
        ],
        nextCursor: null,
      })),
    };
    const service = new DoctorsService(repository as never);
    const input = doctorSearchSchema.parse({ includeUnverified: true });

    const adminResults = await service.search(input, {
      id: 'admin-id',
      role: 'ADMIN',
      iat: 1,
      jti: 'admin-token-id',
    });
    const patientResults = await service.search(
      doctorSearchSchema.parse({}),
      { id: 'patient-id', role: 'PATIENT', iat: 1, jti: 'patient-token-id' },
    );

    expect(adminResults.data).toEqual([
      expect.objectContaining({ id: 'doctor-profile-id', verificationStatus: 'PENDING' }),
    ]);
    expect(patientResults.data).toEqual([
      expect.not.objectContaining({ verificationStatus: expect.anything() }),
    ]);
  });

  it('binds encrypted consultation reasons to the generated consultation row id', async () => {
    const repository = {
      book: jest.fn(async (input: { id: string; reasonEnc?: string }) => ({
        status: 201,
        body: { id: input.id },
        replay: false,
      })),
    };
    const encryption = {
      encrypt: jest.fn(async (_plaintext: string, aad: string) => `encrypted:${aad}`),
    };
    const service = new ConsultationsService(repository as never, {} as never, encryption as never);

    await service.book(
      { id: 'patient-id', role: 'PATIENT', iat: 1, jti: 'token-id' },
      'request-key-123',
      { slotId: '00000000-0000-4000-8000-000000000001', mode: 'VIDEO', reason: 'Follow-up' },
    );

    const input = repository.book.mock.calls[0]?.[0];
    expect(input?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(encryption.encrypt).toHaveBeenCalledWith(
      'Follow-up',
      `consultations.reason_enc:${input?.id}`,
    );
    expect(input?.reasonEnc).toBe(`encrypted:consultations.reason_enc:${input?.id}`);
  });

  describe('consultation state machine', () => {
    it.each([
      ['PENDING_PAYMENT', 'PAYMENT_SUCCEEDED', 'SYSTEM', 'CONFIRMED'],
      ['PENDING_PAYMENT', 'PAYMENT_FAILED', 'SYSTEM', 'CANCELLED'],
      ['PENDING_PAYMENT', 'EXPIRE', 'SYSTEM', 'EXPIRED'],
      ['PENDING_PAYMENT', 'CANCEL', 'PATIENT', 'CANCELLED'],
      ['CONFIRMED', 'CANCEL', 'DOCTOR', 'CANCELLED'],
      ['CONFIRMED', 'START', 'DOCTOR', 'IN_PROGRESS'],
      ['CONFIRMED', 'NO_SHOW', 'DOCTOR', 'NO_SHOW'],
      ['IN_PROGRESS', 'COMPLETE', 'DOCTOR', 'COMPLETED'],
    ] as const)('transitions %s on %s', (current, event, actor, expected) => {
      if (event === 'START') {
        const start = new Date(Date.now() - 60_000);
        expect(
          transition(
            current,
            event,
            actor,
            new Date(),
            start,
            new Date(start.getTime() + 30 * 60_000),
          ),
        ).toBe(expected);
      } else if (event === 'NO_SHOW') {
        const start = new Date(Date.now() - 11 * 60_000);
        expect(
          transition(
            current,
            event,
            actor,
            new Date(),
            start,
            new Date(start.getTime() + 30 * 60_000),
          ),
        ).toBe(expected);
      } else {
        expect(transition(current, event, actor)).toBe(expected);
      }
    });

    it.each([
      ['COMPLETED', 'CANCEL', 'PATIENT'],
      ['PENDING_PAYMENT', 'START', 'DOCTOR'],
      ['CONFIRMED', 'PAYMENT_FAILED', 'SYSTEM'],
      ['IN_PROGRESS', 'NO_SHOW', 'DOCTOR'],
      ['CONFIRMED', 'START', 'PATIENT'],
    ] as const)('rejects %s on %s', (current, event, actor) => {
      expect(() => transition(current, event, actor)).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_STATE }),
      );
    });

    it('enforces start and no-show time windows', () => {
      const start = new Date('2026-10-27T10:00:00Z');
      const end = new Date('2026-10-27T10:30:00Z');
      expect(() =>
        transition('CONFIRMED', 'START', 'DOCTOR', new Date('2026-10-27T09:49:00Z'), start, end),
      ).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_STATE }));
      expect(() =>
        transition('CONFIRMED', 'NO_SHOW', 'DOCTOR', new Date('2026-10-27T10:09:00Z'), start, end),
      ).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_STATE }));
    });
  });

  it('creates stable idempotency hashes and rejects missing keys', async () => {
    const service = new IdempotencyService();
    expect(service.hash('post', '/consultations', { b: 2, a: 1 })).toBe(
      service.hash('POST', '/consultations', { a: 1, b: 2 }),
    );
    await expect(
      service.begin({} as never, 'user', undefined, 'POST', '/x', {}),
    ).rejects.toMatchObject({ code: ERROR_CODES.IDEMPOTENCY_KEY_REQUIRED, status: 422 });
  });

  it('rejects reusing a key for a different request payload', async () => {
    const repository = {
      begin: async () => ({
        inserted: false,
        record: {
          request_hash: 'another-request',
          response_status: 200,
          response_body: { ok: true },
        },
      }),
    };
    const service = new IdempotencyService(repository as never);
    await expect(
      service.begin({} as never, 'user', 'request-key-123', 'POST', '/path', {}),
    ).rejects.toMatchObject({ code: ERROR_CODES.IDEMPOTENCY_KEY_REUSED, status: 422 });
  });

  it('rejects invalid booking shape and identifies key reuse as a 422', () => {
    expect(bookConsultationSchema.safeParse({ slotId: 'not-a-uuid', mode: 'VIDEO' }).success).toBe(
      false,
    );
    const reused = new AppError(
      ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
      422,
      ERROR_CODES.IDEMPOTENCY_KEY_REUSED,
    );
    expect(reused.status).toBe(422);
  });

  it('authenticates timestamped payment webhooks before applying them', async () => {
    const secret = 'unit-test-webhook-secret';
    const gateway = new MockPaymentGateway(secret);
    const applied: PaymentWebhook[] = [];
    const repository = {
      applyWebhook: async (event: PaymentWebhook) => {
        applied.push(event);
      },
    };
    const service = new PaymentsService(repository as never, gateway, secret);
    const event: PaymentWebhook = {
      id: 'evt_unit_1',
      type: 'payment.succeeded',
      data: { paymentId: 'payment-id', amountMinor: 12500 },
    };
    const signed = gateway.createWebhook(event);
    await service.verifyAndApply(signed.rawBody, signed.signature);
    expect(applied).toEqual([event]);
    await expect(
      service.verifyAndApply(signed.rawBody, 't=1,v1=' + '0'.repeat(64)),
    ).rejects.toMatchObject({ code: ERROR_CODES.WEBHOOK_SIGNATURE_INVALID, status: 401 });
    await expect(service.verifyAndApply(signed.rawBody, undefined)).rejects.toMatchObject({
      code: ERROR_CODES.WEBHOOK_SIGNATURE_INVALID,
      status: 401,
    });
  });
});
