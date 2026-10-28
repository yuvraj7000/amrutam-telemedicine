import type { Pool } from 'pg';
import { primaryPool, readPool } from '../../common/db/kysely.js';
import { AppError, ERROR_CODES } from '../../common/errors/index.js';
import { recordAudit } from '../audit/hash-chain.js';
import type { DoctorProfileInput, DoctorSearchInput } from './doctors.schemas.js';

type DoctorRow = Record<string, unknown> & { id: string };
const doctorFields = `d.id,d.user_id,d.display_name,d.verification_status,d.specializations,d.languages,
  d.bio,d.years_experience,d.consultation_fee_minor,d.currency,d.modes,d.rating_avg,d.rating_count,
  d.is_accepting,d.created_at`;

export class DoctorsRepository {
  constructor(
    private readonly pool: Pool = primaryPool,
    private readonly replica: Pool | undefined = readPool,
  ) {}

  async updateProfile(userId: string, input: DoctorProfileInput): Promise<DoctorRow | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<DoctorRow>(
        `UPDATE doctors SET specializations=$2,languages=$3,bio=$4,years_experience=$5,
         consultation_fee_minor=$6,modes=$7,is_accepting=$8,version=version+1
         WHERE user_id=$1 RETURNING id,user_id,display_name,verification_status,specializations,languages,
         bio,years_experience,consultation_fee_minor,currency,modes,rating_avg,rating_count,is_accepting,created_at`,
        [
          userId,
          input.specializations,
          input.languages,
          input.bio ?? null,
          input.yearsExperience,
          input.consultationFeeMinor,
          input.modes,
          input.isAccepting,
        ],
      );
      if (result.rows[0]) {
        await recordAudit(client, {
          actorId: userId,
          actorRole: 'DOCTOR',
          action: 'doctor.profile.update',
          resourceType: 'doctor',
          resourceId: result.rows[0].id,
          outcome: 'SUCCESS',
        });
      }
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getById(id: string): Promise<DoctorRow | undefined> {
    const result = await this.pool.query<DoctorRow>(
      `SELECT ${doctorFields} FROM doctors d WHERE d.id=$1`,
      [id],
    );
    return result.rows[0];
  }

  async search(
    input: DoctorSearchInput,
  ): Promise<{ rows: DoctorRow[]; nextCursor: string | null }> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (value: unknown, cast = ''): string => {
      values.push(value);
      return `$${values.length}${cast}`;
    };
    if (!input.includeUnverified)
      clauses.push(`d.verification_status='VERIFIED' AND d.is_accepting=true`);
    if (input.q) {
      const p = add(input.q);
      clauses.push(
        `(d.search_vector @@ websearch_to_tsquery('simple',${p}) OR d.display_name % ${p})`,
      );
    }
    if (input.specialization)
      clauses.push(
        `d.specializations && ${add(Array.isArray(input.specialization) ? input.specialization : [input.specialization], '::text[]')}`,
      );
    if (input.language)
      clauses.push(
        `d.languages && ${add(Array.isArray(input.language) ? input.language : [input.language], '::text[]')}`,
      );
    if (input.mode) clauses.push(`${add(input.mode)}=ANY(d.modes)`);
    if (input.minFee !== undefined) clauses.push(`d.consultation_fee_minor>=${add(input.minFee)}`);
    if (input.maxFee !== undefined) clauses.push(`d.consultation_fee_minor<=${add(input.maxFee)}`);
    if (input.minRating !== undefined) clauses.push(`d.rating_avg>=${add(input.minRating)}`);
    if (input.availableFrom && input.availableTo) {
      const from = add(input.availableFrom);
      const to = add(input.availableTo);
      clauses.push(`EXISTS (SELECT 1 FROM availability_slots s WHERE s.doctor_id=d.id AND s.start_time >= ${from}
        AND s.start_time < ${to} AND (s.status='AVAILABLE' OR (s.status='HELD' AND s.held_until < now())))`);
    }
    const cursor = decodeCursor(input.cursor);
    if (cursor && cursor.sort !== input.sort) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        422,
        'Cursor does not match the selected sort.',
      );
    }
    let cursorClause = '';
    if (cursor) {
      const id = add(cursor.id, '::uuid');
      if (input.sort === 'rating') {
        const value = add(cursor.value);
        cursorClause = `(rating_avg < ${value} OR (rating_avg=${value} AND id>${id}))`;
      } else if (input.sort === 'fee_asc' || input.sort === 'fee_desc') {
        const value = add(cursor.value);
        const compare = input.sort === 'fee_asc' ? '>' : '<';
        cursorClause = `(consultation_fee_minor ${compare} ${value} OR (consultation_fee_minor=${value} AND id>${id}))`;
      } else if (input.sort === 'experience') {
        const value = add(cursor.value);
        cursorClause = `(COALESCE(years_experience,-1) < ${value} OR (COALESCE(years_experience,-1)=${value} AND id>${id}))`;
      } else {
        const value = add(cursor.value, '::timestamptz');
        cursorClause = `((${value} IS NULL AND next_available_at IS NULL AND id>${id}) OR
          (${value} IS NOT NULL AND (next_available_at>${value} OR (next_available_at=${value} AND id>${id}) OR next_available_at IS NULL)))`;
      }
    }
    const limit = input.limit;
    const order = {
      rating: 'rating_avg DESC,id ASC',
      fee_asc: 'consultation_fee_minor ASC,id ASC',
      fee_desc: 'consultation_fee_minor DESC,id ASC',
      experience: 'COALESCE(years_experience,-1) DESC,id ASC',
      next_available: 'next_available_at ASC NULLS LAST,id ASC',
    }[input.sort];
    const query = `SELECT * FROM (SELECT ${doctorFields},
        (SELECT min(s.start_time) FROM availability_slots s WHERE s.doctor_id=d.id AND s.start_time>now()
         AND (s.status='AVAILABLE' OR (s.status='HELD' AND s.held_until<now()))) AS next_available_at
      FROM doctors d ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}) AS doctor_page
      ${cursorClause ? `WHERE ${cursorClause}` : ''}
      ORDER BY ${order} LIMIT ${add(limit + 1)}`;
    const result = await (this.replica ?? this.pool).query<DoctorRow>(query, values);
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return { rows, nextCursor: hasMore && last ? encodeCursor(input.sort, last) : null };
  }

  async setVerification(
    id: string,
    status: 'VERIFIED' | 'REJECTED',
    adminId: string,
    note?: string,
  ): Promise<DoctorRow | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<DoctorRow>(
        `UPDATE doctors SET verification_status=$2,verified_by=$3,
         verified_at=CASE
           WHEN $2::verification_status='VERIFIED'::verification_status THEN now()
           ELSE NULL
         END,version=version+1
         WHERE id=$1 RETURNING id,user_id,display_name,verification_status,specializations,languages,
         bio,years_experience,consultation_fee_minor,currency,modes,rating_avg,rating_count,is_accepting,created_at`,
        [id, status, adminId],
      );
      if (result.rows[0]) {
        await recordAudit(client, {
          actorId: adminId,
          actorRole: 'ADMIN',
          action: 'doctor.verification.update',
          resourceType: 'doctor',
          resourceId: id,
          outcome: 'SUCCESS',
          metadata: { status, ...(note ? { note } : {}) },
        });
      }
      await client.query('COMMIT');
      return result.rows[0];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

type DoctorCursor = { sort: DoctorSearchInput['sort']; value: string | number | null; id: string };
function decodeCursor(cursor: string | undefined): DoctorCursor | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'sort' in parsed &&
      'value' in parsed &&
      'id' in parsed
    ) {
      const value = parsed as Record<string, unknown>;
      if (
        typeof value.sort === 'string' &&
        ['rating', 'fee_asc', 'fee_desc', 'experience', 'next_available'].includes(value.sort) &&
        (typeof value.value === 'number' ||
          typeof value.value === 'string' ||
          value.value === null) &&
        typeof value.id === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.id)
      ) {
        return value as DoctorCursor;
      }
    }
  } catch {
    // Report malformed cursors as validation errors below.
  }
  throw new AppError(ERROR_CODES.VALIDATION_ERROR, 422, 'Invalid cursor.');
}

function encodeCursor(sort: DoctorSearchInput['sort'], row: DoctorRow): string {
  const value =
    sort === 'rating'
      ? Number(row.rating_avg)
      : sort === 'fee_asc' || sort === 'fee_desc'
        ? Number(row.consultation_fee_minor)
        : sort === 'experience'
          ? Number(row.years_experience ?? -1)
          : row.next_available_at
            ? new Date(row.next_available_at as string | Date).toISOString()
            : null;
  return Buffer.from(JSON.stringify({ sort, value, id: row.id })).toString('base64url');
}
