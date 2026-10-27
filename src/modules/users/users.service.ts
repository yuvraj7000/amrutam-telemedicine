import type { EncryptionService } from '../../common/crypto/encryption.service.js';
import type { UsersRepository } from './users.repository.js';
import type { ProfileInput } from './users.schemas.js';
export class UsersService {
  constructor(private readonly usersRepository: UsersRepository, private readonly encryptionService: EncryptionService) {}
  async getMe(id: string): Promise<Record<string, unknown> | undefined> {
    const row = await this.usersRepository.getMe(id); if (!row) return undefined;
    for (const column of ['date_of_birth_enc', 'address_enc', 'emergency_contact_enc']) {
      const value = row[column]; if (typeof value === 'string') row[column] = this.encryptionService.decrypt(value, `profiles.${column.replace('_enc', '')}:${id}`);
    }
    return { id: row.id, email: row.email, phone: row.phone, role: row.role, status: row.status, mfaEnabled: row.mfa_enabled,
      profile: { fullName: row.full_name, gender: row.gender, dateOfBirth: row.date_of_birth_enc, address: row.address_enc, emergencyContact: row.emergency_contact_enc, locale: row.locale, timezone: row.timezone } };
  }
  async updatePhone(id: string, phone?: string): Promise<void> { await this.usersRepository.updatePhone(id, phone); }
  async updateProfile(id: string, input: ProfileInput): Promise<Record<string, unknown> | undefined> {
    const encrypted = { ...input, dateOfBirth: input.dateOfBirth ? this.encryptionService.encrypt(input.dateOfBirth, `profiles.date_of_birth:${id}`) : undefined, address: input.address ? this.encryptionService.encrypt(input.address, `profiles.address:${id}`) : undefined, emergencyContact: input.emergencyContact ? this.encryptionService.encrypt(input.emergencyContact, `profiles.emergency_contact:${id}`) : undefined };
    await this.usersRepository.updateProfile(id, encrypted); return this.getMe(id);
  }
}