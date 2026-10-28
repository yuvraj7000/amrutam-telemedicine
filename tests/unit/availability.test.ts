import { ValidationError } from '../../src/common/errors/index.js';
import type { AuthUser } from '../../src/common/middleware/auth.js';
import { AvailabilityRepository } from '../../src/modules/availability/availability.repository.js';
import { AvailabilityService } from '../../src/modules/availability/availability.service.js';
import { createSlotsSchema } from '../../src/modules/availability/availability.schemas.js';

class RecordingAvailabilityRepository extends AvailabilityRepository {
  createCalls = 0;

  override async createSlots(): Promise<{
    created: number;
    skipped: { start: string; reason: string }[];
    replay: boolean;
  }> {
    this.createCalls += 1;
    return { created: 1, skipped: [], replay: false };
  }
}

const doctor: AuthUser = {
  id: 'doctor-id',
  role: 'DOCTOR',
  iat: 1,
  jti: 'token-id',
};

describe('availability slot duration validation', () => {
  it('rejects a slot longer than the database four-hour limit at the request boundary', () => {
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(start.getTime() + 24.5 * 60 * 60 * 1000);
    const result = createSlotsSchema.safeParse({
      slots: [{ start: start.toISOString(), end: end.toISOString() }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['slots', 0, 'end'],
          message: 'A slot cannot be longer than 4 hours.',
        }),
      );
    }
  });

  it('does not send oversized slots to the repository', async () => {
    const repository = new RecordingAvailabilityRepository();
    const service = new AvailabilityService(repository);
    const start = new Date(Date.now() + 86_400_000);
    const end = new Date(start.getTime() + 24.5 * 60 * 60 * 1000);

    await expect(
      service.create(doctor, {
        slots: [{ start: start.toISOString(), end: end.toISOString() }],
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(repository.createCalls).toBe(0);
  });
});
