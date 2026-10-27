import { EncryptionService } from '../../src/common/crypto/encryption.service.js';
import {
  canonicalJson,
  constantTimeEqual,
  hashArgon2id,
  sha256,
  verifyArgon2id,
} from '../../src/common/crypto/hash.js';
import { EnvKeyProvider, type KeyProvider } from '../../src/common/crypto/key-provider.js';

const key = (seed: number): string => Buffer.alloc(32, seed).toString('base64');

describe('crypto', () => {
  it('encrypts and decrypts with authenticated AAD', () => {
    const service = new EncryptionService(
      new EnvKeyProvider({ ENC_KEYS: { '1': key(1) }, ENC_ACTIVE_VERSION: 1 }),
    );
    const encrypted = service.encrypt('clinical reason', 'consultations.reason_enc:row-1');

    expect(service.decrypt(encrypted, 'consultations.reason_enc:row-1')).toBe('clinical reason');
    expect(() => service.decrypt(encrypted, 'consultations.reason_enc:row-2')).toThrow();
  });

  it('rejects tampered ciphertext and produces different values for repeated writes', () => {
    const service = new EncryptionService(
      new EnvKeyProvider({ ENC_KEYS: { '1': key(1) }, ENC_ACTIVE_VERSION: 1 }),
    );
    const first = service.encrypt('same', 'users.email:row-1');
    const second = service.encrypt('same', 'users.email:row-1');
    const parts = first.split(':');
    const tampered = Buffer.from(parts[3] as string, 'base64');
    tampered[0] = (tampered[0] as number) ^ 1;
    parts[3] = tampered.toString('base64');

    expect(first).not.toBe(second);
    expect(() => service.decrypt(parts.join(':'), 'users.email:row-1')).toThrow();
  });

  it('decrypts old key versions after rotation and encrypts with the active version', () => {
    const provider: KeyProvider = new EnvKeyProvider({
      ENC_KEYS: { '1': key(1), '2': key(2) },
      ENC_ACTIVE_VERSION: 1,
    });
    const oldService = new EncryptionService(provider);
    const oldValue = oldService.encrypt('old', 'profiles.address_enc:row-1');
    const rotatedService = new EncryptionService(
      new EnvKeyProvider({
        ENC_KEYS: { '1': key(1), '2': key(2) },
        ENC_ACTIVE_VERSION: 2,
      }),
    );

    expect(rotatedService.decrypt(oldValue, 'profiles.address_enc:row-1')).toBe('old');
    expect(rotatedService.encrypt('new', 'profiles.address_enc:row-1')).toMatch(/^v2:/);
  });

  it('canonicalizes JSON and provides hashing helpers', async () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(sha256('value')).toHaveLength(64);
    expect(constantTimeEqual('same', 'same')).toBe(true);
    expect(constantTimeEqual('same', 'different')).toBe(false);
    const hash = await hashArgon2id('secret');
    expect(await verifyArgon2id(hash, 'secret')).toBe(true);
    expect(await verifyArgon2id(hash, 'wrong')).toBe(false);
  });
});
