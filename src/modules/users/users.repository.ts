import { primaryPool } from '../../common/db/kysely.js';
export class UsersRepository {
  async getMe(id: string): Promise<Record<string, unknown> | undefined> {
    const result = await primaryPool.query<Record<string, unknown>>(
      `SELECT u.id,u.email,u.phone,u.role,u.status,u.mfa_enabled,
       p.full_name,p.gender,p.date_of_birth_enc,p.address_enc,p.emergency_contact_enc,p.locale,p.timezone
       FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.id=$1 AND u.deleted_at IS NULL`, [id]);
    return result.rows[0];
  }
  async updatePhone(id: string, phone: string | undefined): Promise<void> { await primaryPool.query('UPDATE users SET phone=$2 WHERE id=$1', [id, phone ?? null]); }
  async updateProfile(id: string, values: { fullName: string; gender?: string; dateOfBirth?: string; address?: string; emergencyContact?: string; locale?: string; timezone?: string }): Promise<void> {
    await primaryPool.query(
      `UPDATE profiles SET full_name=$2,gender=$3,date_of_birth_enc=$4,address_enc=$5,emergency_contact_enc=$6,locale=COALESCE($7,locale),timezone=COALESCE($8,timezone) WHERE user_id=$1`,
      [id, values.fullName, values.gender ?? null, values.dateOfBirth ?? null, values.address ?? null, values.emergencyContact ?? null, values.locale ?? null, values.timezone ?? null],
    );
  }
}