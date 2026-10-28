import type { Pool } from 'pg';

import { primaryPool } from '../../common/db/kysely.js';
import { sha256 } from '../../common/crypto/hash.js';
export type UserRow = { id: string; email: string; phone: string | null; password_hash: string; role: string; status: string; mfa_enabled: boolean; mfa_secret_enc: string | null; failed_login_count: number; locked_until: Date | null; tokens_valid_after: Date };
export class AuthRepository {
  constructor(private readonly pool: Pool = primaryPool) {}
  async findUser(email: string): Promise<UserRow | undefined> { const result = await this.pool.query<UserRow>('SELECT * FROM users WHERE email=$1 AND deleted_at IS NULL', [email]); return result.rows[0]; }
  async findById(id: string): Promise<UserRow | undefined> { const result = await this.pool.query<UserRow>('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL', [id]); return result.rows[0]; }
  async register(input: { email: string; phone?: string; passwordHash: string; fullName: string; role: string; doctor?: { licenseNumber: string; specializations: string[]; languages: string[]; consultationFeeMinor: number; yearsExperience: number; bio?: string } }): Promise<UserRow> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<UserRow>('INSERT INTO users (email,phone,password_hash,role) VALUES ($1,$2,$3,$4) RETURNING *', [input.email, input.phone ?? null, input.passwordHash, input.role]);
      const user = result.rows[0];
      if (!user) throw new Error('User insert did not return a row');
      await client.query('INSERT INTO profiles (user_id,full_name) VALUES ($1,$2)', [user.id, input.fullName]);
      if (input.doctor) await client.query('INSERT INTO doctors (user_id,display_name,license_number,specializations,languages,bio,years_experience,consultation_fee_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [user.id, input.fullName, input.doctor.licenseNumber, input.doctor.specializations, input.doctor.languages, input.doctor.bio ?? null, input.doctor.yearsExperience, input.doctor.consultationFeeMinor]);
      await client.query('COMMIT'); return user;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async recordFailure(id: string, max: number, minutes: number): Promise<void> { await this.pool.query(`UPDATE users SET failed_login_count=failed_login_count+1, locked_until=CASE WHEN failed_login_count+1 >= $2 THEN now()+($3||' minutes')::interval ELSE locked_until END WHERE id=$1`, [id, max, minutes]); }
  async resetFailures(id: string): Promise<void> { await this.pool.query('UPDATE users SET failed_login_count=0,locked_until=NULL,last_login_at=now() WHERE id=$1', [id]); }
  async setMfaSecret(id: string, encryptedSecret: string): Promise<void> {
    const result = await this.pool.query('UPDATE users SET mfa_secret_enc=$2 WHERE id=$1 AND mfa_enabled=false', [id, encryptedSecret]);
    if (result.rowCount !== 1) throw new Error('MFA enrollment state changed during setup');
  }
  async enableMfa(id: string, codeHashes: string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM mfa_backup_codes WHERE user_id=$1', [id]);
      for (const hash of codeHashes) {
        await client.query('INSERT INTO mfa_backup_codes (user_id,code_hash) VALUES ($1,$2)', [id, hash]);
      }
      const result = await client.query('UPDATE users SET mfa_enabled=true,tokens_valid_after=now() WHERE id=$1 AND mfa_secret_enc IS NOT NULL AND mfa_enabled=false', [id]);
      if (result.rowCount !== 1) throw new Error('MFA enrollment state changed during enablement');
      await client.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async consumeBackupCode(id: string, code: string, verify: (hash: string, value: string) => Promise<boolean>): Promise<boolean> {
    const result = await this.pool.query<{ id: string; code_hash: string }>(
      'SELECT id,code_hash FROM mfa_backup_codes WHERE user_id=$1 AND used_at IS NULL',
      [id],
    );
    for (const row of result.rows) {
      if (await verify(row.code_hash, code)) {
        const consumed = await this.pool.query(
          'UPDATE mfa_backup_codes SET used_at=now() WHERE id=$1 AND used_at IS NULL',
          [row.id],
        );
        if (consumed.rowCount === 1) return true;
      }
    }
    return false;
  }
  async disableMfa(id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET mfa_enabled=false,mfa_secret_enc=NULL,tokens_valid_after=now() WHERE id=$1', [id]);
      await client.query('DELETE FROM mfa_backup_codes WHERE user_id=$1', [id]);
      await client.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async refresh(hash: string): Promise<{ id: string; user_id: string; family_id: string; revoked_at: Date | null; expires_at: Date } | undefined> { const result = await this.pool.query<{ id: string; user_id: string; family_id: string; revoked_at: Date | null; expires_at: Date }>('SELECT id,user_id,family_id,revoked_at,expires_at FROM refresh_tokens WHERE token_hash=$1', [hash]); return result.rows[0]; }
  async revokeFamily(family: string): Promise<void> { await this.pool.query('UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE family_id=$1', [family]); }
  async revokeToken(id: string, replacement?: string): Promise<void> {
    if (replacement) await this.pool.query('UPDATE refresh_tokens SET revoked_at=now(),replaced_by=$2 WHERE id=$1 AND revoked_at IS NULL', [id, replacement]);
    else await this.pool.query('UPDATE refresh_tokens SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [id]);
  }
  async saveRefresh(userId: string, family: string, hash: string, expiry: Date, ip?: string, agent?: string): Promise<void> { await this.pool.query('INSERT INTO refresh_tokens (user_id,family_id,token_hash,expires_at,ip,user_agent) VALUES ($1,$2,$3,$4,$5,$6)', [userId, family, hash, expiry, ip ?? null, agent ?? null]); }
  async revokeUserTokens(id: string): Promise<void> { await this.pool.query('UPDATE refresh_tokens SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]); }
  async bumpTva(id: string): Promise<void> { await this.pool.query('UPDATE users SET tokens_valid_after=now() WHERE id=$1', [id]); }
  async updatePassword(id: string, hash: string): Promise<void> { await this.pool.query('UPDATE users SET password_hash=$2,tokens_valid_after=now() WHERE id=$1', [id, hash]); }
  hashRefresh(token: string): string { return sha256(token); }
}