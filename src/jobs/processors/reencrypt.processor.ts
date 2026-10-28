import type { EncryptionService } from '../../common/crypto/encryption.service.js';
import { primaryPool } from '../../common/db/kysely.js';

interface EncryptedRow {
  id: string;
  value: string;
}

interface EncryptedColumn {
  table: 'profiles' | 'users' | 'consultations' | 'prescriptions';
  idColumn: 'user_id' | 'id';
  column:
    | 'date_of_birth_enc'
    | 'address_enc'
    | 'emergency_contact_enc'
    | 'mfa_secret_enc'
    | 'reason_enc'
    | 'doctor_notes_enc'
    | 'payload_enc';
}

const encryptedColumns: EncryptedColumn[] = [
  { table: 'profiles', idColumn: 'user_id', column: 'date_of_birth_enc' },
  { table: 'profiles', idColumn: 'user_id', column: 'address_enc' },
  { table: 'profiles', idColumn: 'user_id', column: 'emergency_contact_enc' },
  { table: 'users', idColumn: 'id', column: 'mfa_secret_enc' },
  { table: 'consultations', idColumn: 'id', column: 'reason_enc' },
  { table: 'consultations', idColumn: 'id', column: 'doctor_notes_enc' },
  { table: 'prescriptions', idColumn: 'id', column: 'payload_enc' },
];

const BATCH_SIZE = 500;

export async function processReencrypt(
  encryptionService: EncryptionService,
  activeVersion: number,
  activeKmsKey = false,
): Promise<number> {
  let updated = 0;

  for (const encrypted of encryptedColumns) {
    for (;;) {
      const candidates = await primaryPool.query<EncryptedRow>(
        `SELECT ${encrypted.idColumn} AS id, ${encrypted.column} AS value
         FROM ${encrypted.table}
         WHERE ${encrypted.column} LIKE 'v%'
           AND (
             ${encrypted.column} NOT LIKE $1
             OR ($3::boolean AND length(${encrypted.column}) - length(replace(${encrypted.column}, ':', '')) = 3)
           )
         ORDER BY ${encrypted.idColumn}
         LIMIT $2`,
        [`v${activeVersion}:%`, BATCH_SIZE, activeKmsKey],
      );
      if (candidates.rows.length === 0) break;

      let changed = 0;
      for (const row of candidates.rows) {
        const aad = `${encrypted.table}.${encrypted.column}:${row.id}`;
        const plaintext = await encryptionService.decrypt(row.value, aad);
        const replacement = await encryptionService.encrypt(plaintext, aad);
        const result = await primaryPool.query(
          `UPDATE ${encrypted.table}
           SET ${encrypted.column} = $2
           WHERE ${encrypted.idColumn} = $1 AND ${encrypted.column} = $3`,
          [row.id, replacement, row.value],
        );
        changed += result.rowCount ?? 0;
      }

      updated += changed;
      if (candidates.rows.length < BATCH_SIZE || changed === 0) break;
    }
  }
  return updated;
}
