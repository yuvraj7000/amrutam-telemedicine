import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { env } from '../../config/env.js';

export interface KeyMaterial {
  key: Buffer;
  wrappedKey?: Buffer;
}

export interface KeyProvider {
  getKey(version: number, wrappedKey?: Buffer): Promise<Buffer>;
  getEncryptionKey(version: number): Promise<KeyMaterial>;
  activeVersion(): number;
  close?(): void;
}

export interface KeyProviderConfig {
  ENC_KEYS?: Record<string, string>;
  ENC_ACTIVE_VERSION: number;
  KMS_KEY_ID?: string;
}

function decodeKey(version: number, encodedKey: string | undefined): Buffer {
  if (!encodedKey) {
    throw new Error(`Encryption key version ${version} is not configured`);
  }

  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encodedKey) {
    throw new Error(`Encryption key version ${version} must be a base64-encoded 32-byte key`);
  }
  return key;
}

export class EnvKeyProvider implements KeyProvider {
  private readonly keys: Record<string, string>;
  private readonly version: number;

  constructor(config: KeyProviderConfig = env) {
    this.keys = config.ENC_KEYS ?? {};
    this.version = config.ENC_ACTIVE_VERSION;
  }

  async getKey(version: number, wrappedKey?: Buffer): Promise<Buffer> {
    if (wrappedKey) throw new Error('Wrapped KMS keys cannot be used with EnvKeyProvider');
    return decodeKey(version, this.keys[String(version)]);
  }

  async getEncryptionKey(version: number): Promise<KeyMaterial> {
    return { key: await this.getKey(version) };
  }

  activeVersion(): number {
    return this.version;
  }
}

export interface KmsOperations {
  generateDataKey(keyId: string): Promise<{ Plaintext?: Uint8Array; CiphertextBlob?: Uint8Array }>;
  decrypt(ciphertext: Uint8Array): Promise<{ Plaintext?: Uint8Array }>;
}

interface CachedKey extends KeyMaterial {
  expiresAt: number;
}

const KEY_CACHE_TTL_MS = 5 * 60 * 1000;
const KMS_ENCRYPTION_CONTEXT = { purpose: 'amrutam-field-encryption' };

export class KmsKeyProvider implements KeyProvider {
  private readonly keyId: string;
  private readonly envProvider?: EnvKeyProvider;
  private readonly operations: KmsOperations;
  private readonly client?: KMSClient;
  private readonly now: () => number;
  private activeKey: (CachedKey & { wrappedKey: Buffer }) | undefined;
  private readonly decryptedKeys = new Map<string, CachedKey>();

  constructor(
    config: KeyProviderConfig = env,
    operations?: KmsOperations,
    now: () => number = Date.now,
  ) {
    if (!config.KMS_KEY_ID) throw new Error('KMS_KEY_ID must be configured for KmsKeyProvider');
    this.keyId = config.KMS_KEY_ID;
    this.envProvider = config.ENC_KEYS ? new EnvKeyProvider(config) : undefined;
    this.now = now;
    if (operations) {
      this.operations = operations;
    } else {
      const client = new KMSClient({});
      this.client = client;
      this.operations = {
        generateDataKey: (keyId) =>
          client.send(
            new GenerateDataKeyCommand({
              KeyId: keyId,
              KeySpec: 'AES_256',
              EncryptionContext: KMS_ENCRYPTION_CONTEXT,
            }),
          ),
        decrypt: (ciphertext) =>
          client.send(
            new DecryptCommand({
              CiphertextBlob: ciphertext,
              EncryptionContext: KMS_ENCRYPTION_CONTEXT,
            }),
          ),
      };
    }
  }

  private pruneExpiredKeys(): void {
    const now = this.now();
    for (const [cacheKey, cached] of this.decryptedKeys) {
      if (cached.expiresAt <= now) {
        cached.key.fill(0);
        this.decryptedKeys.delete(cacheKey);
      }
    }
    if (this.activeKey && this.activeKey.expiresAt <= now) this.activeKey = undefined;
  }

  activeVersion(): number {
    return 1;
  }

  close(): void {
    for (const cached of this.decryptedKeys.values()) cached.key.fill(0);
    this.decryptedKeys.clear();
    this.activeKey?.key.fill(0);
    this.activeKey = undefined;
    this.client?.destroy();
  }

  async getEncryptionKey(version: number): Promise<KeyMaterial> {
    if (version !== this.activeVersion()) {
      throw new Error(`Encryption key version ${version} is not supported by KmsKeyProvider`);
    }

    this.pruneExpiredKeys();
    if (this.activeKey && this.activeKey.expiresAt > this.now()) {
      return {
        key: Buffer.from(this.activeKey.key),
        wrappedKey: Buffer.from(this.activeKey.wrappedKey),
      };
    }

    const result = await this.operations.generateDataKey(this.keyId);
    if (!result.Plaintext || !result.CiphertextBlob || result.Plaintext.length !== 32) {
      throw new Error('AWS KMS did not return a valid AES-256 data key');
    }

    const key = Buffer.from(result.Plaintext);
    const wrappedKey = Buffer.from(result.CiphertextBlob);
    this.activeKey = { key, wrappedKey, expiresAt: this.now() + KEY_CACHE_TTL_MS };
    this.decryptedKeys.set(wrappedKey.toString('base64'), this.activeKey);
    return { key: Buffer.from(key), wrappedKey: Buffer.from(wrappedKey) };
  }

  async getKey(version: number, wrappedKey?: Buffer): Promise<Buffer> {
    if (!wrappedKey && this.envProvider) return this.envProvider.getKey(version);
    if (version !== this.activeVersion() || !wrappedKey || wrappedKey.length === 0) {
      throw new Error('A valid wrapped KMS key is required to decrypt this value');
    }

    this.pruneExpiredKeys();
    const cacheKey = wrappedKey.toString('base64');
    const cached = this.decryptedKeys.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return Buffer.from(cached.key);
    if (cached) this.decryptedKeys.delete(cacheKey);

    const result = await this.operations.decrypt(new Uint8Array(wrappedKey));
    if (!result.Plaintext || result.Plaintext.length !== 32) {
      throw new Error('AWS KMS did not return a valid AES-256 data key');
    }

    const key = Buffer.from(result.Plaintext);
    const cachedKey = { key, expiresAt: this.now() + KEY_CACHE_TTL_MS };
    this.decryptedKeys.set(cacheKey, cachedKey);
    return Buffer.from(key);
  }
}

export function createKeyProvider(config: KeyProviderConfig = env): KeyProvider {
  return config.KMS_KEY_ID ? new KmsKeyProvider(config) : new EnvKeyProvider(config);
}
