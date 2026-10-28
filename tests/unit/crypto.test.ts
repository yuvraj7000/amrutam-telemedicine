import { EncryptionService } from '../../src/common/crypto/encryption.service.js';
import {
  canonicalJson,
  constantTimeEqual,
  hashArgon2id,
  sha256,
  verifyArgon2id,
} from '../../src/common/crypto/hash.js';
import {
  EnvKeyProvider,
  KmsKeyProvider,
  type KeyProvider,
  type KmsOperations,
} from '../../src/common/crypto/key-provider.js';

const key = (seed: number): string => Buffer.alloc(32, seed).toString('base64');

describe('crypto', () => {
  it('encrypts and decrypts with authenticated AAD', async () => {
    const service = new EncryptionService(
      new EnvKeyProvider({ ENC_KEYS: { '1': key(1) }, ENC_ACTIVE_VERSION: 1 }),
    );
    const encrypted = await service.encrypt('clinical reason', 'consultations.reason_enc:row-1');

    await expect(service.decrypt(encrypted, 'consultations.reason_enc:row-1')).resolves.toBe(
      'clinical reason',
    );
    await expect(service.decrypt(encrypted, 'consultations.reason_enc:row-2')).rejects.toThrow();
  });

  it('rejects tampered ciphertext and produces different values for repeated writes', async () => {
    const service = new EncryptionService(
      new EnvKeyProvider({ ENC_KEYS: { '1': key(1) }, ENC_ACTIVE_VERSION: 1 }),
    );
    const first = await service.encrypt('same', 'users.email:row-1');
    const second = await service.encrypt('same', 'users.email:row-1');
    const parts = first.split(':');
    const tampered = Buffer.from(parts[3] as string, 'base64');
    tampered[0] = (tampered[0] as number) ^ 1;
    parts[3] = tampered.toString('base64');

    expect(first).not.toBe(second);
    await expect(service.decrypt(parts.join(':'), 'users.email:row-1')).rejects.toThrow();
  });

  it('decrypts old key versions after rotation and encrypts with the active version', async () => {
    const provider: KeyProvider = new EnvKeyProvider({
      ENC_KEYS: { '1': key(1), '2': key(2) },
      ENC_ACTIVE_VERSION: 1,
    });
    const oldService = new EncryptionService(provider);
    const oldValue = await oldService.encrypt('old', 'profiles.address_enc:row-1');
    const rotatedService = new EncryptionService(
      new EnvKeyProvider({
        ENC_KEYS: { '1': key(1), '2': key(2) },
        ENC_ACTIVE_VERSION: 2,
      }),
    );

    await expect(rotatedService.decrypt(oldValue, 'profiles.address_enc:row-1')).resolves.toBe(
      'old',
    );
    await expect(rotatedService.encrypt('new', 'profiles.address_enc:row-1')).resolves.toMatch(
      /^v2:/,
    );
  });

  it('uses KMS-wrapped data keys and caches them for five minutes', async () => {
    const plaintextKey = Buffer.alloc(32, 4);
    const wrappedKey = Buffer.from('kms-wrapped-data-key');
    const envProvider = new EnvKeyProvider({
      ENC_KEYS: { '2': key(2) },
      ENC_ACTIVE_VERSION: 2,
    });
    const envService = new EncryptionService(envProvider);
    const legacyValue = await envService.encrypt('legacy data', 'profiles.address:patient-1');
    const operations: KmsOperations = {
      generateDataKey: jest.fn(async () => ({
        Plaintext: plaintextKey,
        CiphertextBlob: wrappedKey,
      })),
      decrypt: jest.fn(async () => ({ Plaintext: plaintextKey })),
    };
    let now = 0;
    const provider = new KmsKeyProvider(
      {
        ENC_KEYS: { '2': key(2) },
        ENC_ACTIVE_VERSION: 2,
        KMS_KEY_ID: 'alias/amrutam-data',
      },
      operations,
      () => now,
    );
    const service = new EncryptionService(provider);
    await expect(service.decrypt(legacyValue, 'profiles.address:patient-1')).resolves.toBe(
      'legacy data',
    );
    const encrypted = await service.encrypt('patient data', 'profiles.address:patient-1');
    expect(encrypted.split(':')).toHaveLength(5);
    await expect(service.decrypt(encrypted, 'profiles.address:patient-1')).resolves.toBe(
      'patient data',
    );
    expect(operations.generateDataKey).toHaveBeenCalledTimes(1);
    expect(operations.decrypt).not.toHaveBeenCalled();

    now += 5 * 60 * 1000 + 1;
    await expect(service.decrypt(encrypted, 'profiles.address:patient-1')).resolves.toBe(
      'patient data',
    );
    expect(operations.decrypt).toHaveBeenCalledTimes(1);
    await service.encrypt('new patient data', 'profiles.address:patient-2');
    expect(operations.generateDataKey).toHaveBeenCalledTimes(2);
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
