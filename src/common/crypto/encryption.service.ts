import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { KeyProvider } from './key-provider.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export class EncryptionService {
  constructor(private readonly keyProvider: KeyProvider) {}

  async encrypt(plain: string, aad: string): Promise<string> {
    const version = this.keyProvider.activeVersion();
    const material = await this.keyProvider.getEncryptionKey(version);
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, material.key, iv, {
      authTagLength: TAG_LENGTH,
    });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const wrappedKey = material.wrappedKey ? `${material.wrappedKey.toString('base64')}:` : '';
    return `v${version}:${wrappedKey}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
  }

  async decrypt(stored: string, aad: string): Promise<string> {
    const parts = stored.split(':');
    if ((parts.length !== 4 && parts.length !== 5) || !/^v[1-9]\d*$/.test(parts[0] ?? '')) {
      throw new Error('Invalid encrypted value format');
    }

    const version = Number((parts[0] as string).slice(1));
    const wrappedKey = parts.length === 5 ? Buffer.from(parts[1] as string, 'base64') : undefined;
    const ivIndex = parts.length === 5 ? 2 : 1;
    const iv = Buffer.from(parts[ivIndex] as string, 'base64');
    const tag = Buffer.from(parts[ivIndex + 1] as string, 'base64');
    const ciphertext = Buffer.from(parts[ivIndex + 2] as string, 'base64');
    if (
      (wrappedKey && wrappedKey.length === 0) ||
      (wrappedKey && wrappedKey.toString('base64') !== parts[1]) ||
      iv.toString('base64') !== parts[ivIndex] ||
      tag.toString('base64') !== parts[ivIndex + 1] ||
      ciphertext.toString('base64') !== parts[ivIndex + 2]
    ) {
      throw new Error('Invalid encrypted value format');
    }
    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH || ciphertext.length === 0) {
      throw new Error('Invalid encrypted value format');
    }

    const key = await this.keyProvider.getKey(version, wrappedKey);
    const decipher = createDecipheriv(ALGORITHM, key, iv, {
      authTagLength: TAG_LENGTH,
    });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
