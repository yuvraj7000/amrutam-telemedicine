import { ForbiddenError, NotFoundError } from '../../common/errors/index.js';
import type { AuthUser } from '../../common/middleware/auth.js';
import type { DoctorProfileInput, DoctorSearchInput } from './doctors.schemas.js';
import type { DoctorsRepository } from './doctors.repository.js';

export class DoctorsService {
  constructor(private readonly repository: DoctorsRepository) {}

  async updateProfile(user: AuthUser, input: DoctorProfileInput): Promise<Record<string, unknown>> {
    if (user.role !== 'DOCTOR') throw new ForbiddenError();
    const row = await this.repository.updateProfile(user.id, input);
    if (!row) throw new NotFoundError('Doctor profile was not found.');
    return doctorDto(row);
  }

  async search(input: DoctorSearchInput, user?: AuthUser): Promise<Record<string, unknown>> {
    if (input.includeUnverified && user?.role !== 'ADMIN') throw new ForbiddenError();
    const result = await this.repository.search(input);
    return {
      data: result.rows.map((row) => doctorDto(row, user?.role === 'ADMIN')),
      meta: { limit: input.limit, nextCursor: result.nextCursor },
    };
  }

  async getById(id: string, user?: AuthUser): Promise<Record<string, unknown>> {
    const row = await this.repository.getById(id);
    if (!row || (row.verification_status !== 'VERIFIED' && user?.role !== 'ADMIN'))
      throw new NotFoundError();
    const value = doctorDto(row);
    if (user?.role !== 'ADMIN') delete value['verificationStatus'];
    return value;
  }

  async setVerification(
    id: string,
    status: 'VERIFIED' | 'REJECTED',
    adminId: string,
    note?: string,
  ): Promise<Record<string, unknown>> {
    const row = await this.repository.setVerification(id, status, adminId, note);
    if (!row) throw new NotFoundError();
    return doctorDto(row);
  }
}

export function doctorDto(
  row: Record<string, unknown>,
  includeVerification = true,
): Record<string, unknown> {
  return {
    id: row.id,
    displayName: row.display_name,
    ...(includeVerification && row.verification_status !== undefined
      ? { verificationStatus: row.verification_status }
      : {}),
    specializations: row.specializations,
    languages: row.languages,
    ...(row.bio !== undefined ? { bio: row.bio } : {}),
    yearsExperience: row.years_experience,
    consultationFeeMinor: row.consultation_fee_minor,
    currency: typeof row.currency === 'string' ? row.currency.trim() : row.currency,
    modes: row.modes,
    ratingAvg: row.rating_avg,
    ratingCount: row.rating_count,
    isAccepting: row.is_accepting,
    ...(row.next_available_at ? { nextAvailableAt: row.next_available_at } : {}),
  };
}
