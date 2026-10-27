import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { KeyProvider } from './key-provider.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class EncryptionService {
  constructor(private readonly keyProvider: KeyProvider) {}

  encrypt(plain: string, aad: string): string {
    const version = this.keyProvider.activeVersion();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.keyProvider.getKey(version), iv, {
      authTagLength: TAG_LENGTH,
    });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return `v${version}:${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString(
      'base64',
    )}`;
  }

  decrypt(stored: string, aad: string): string {
    const parts = stored.split(':');
    if (parts.length !== 4 || !/^v[1-9]\d*$/.test(parts[0] ?? '')) {
      throw new Error('Invalid encrypted value format');
    }

    const version = Number((parts[0] as string).slice(1));
    const iv = Buffer.from(parts[1] as string, 'base64');
    const tag = Buffer.from(parts[2] as string, 'base64');
    const ciphertext = Buffer.from(parts[3] as string, 'base64');
    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH || ciphertext.length === 0) {
      throw new Error('Invalid encrypted value format');
    }

    const decipher = createDecipheriv(ALGORITHM, this.keyProvider.getKey(version), iv, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}