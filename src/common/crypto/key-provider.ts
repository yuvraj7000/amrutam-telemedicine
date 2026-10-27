import { env } from '../../config/env.js';

export interface KeyProvider {
  getKey(version: number): Buffer;
  activeVersion(): number;
}

export interface KeyProviderConfig {
  ENC_KEYS: Record<string, string>;
  ENC_ACTIVE_VERSION: number;
  KMS_KEY_ID?: string;
}

function decodeKey(version: number, encodedKey: string | undefined): Buffer {
  if (!encodedKey) {
    throw new Error(`Encryption key version ${version} is not configured`);
  }

  const key = Buffer.from(encodedKey, 'base64');
  if (key.length !== 32) {
    throw new Error(`Encryption key version ${version} must be a base64-encoded 32-byte key`);
  }
  return key;
}

export class EnvKeyProvider implements KeyProvider {
  private readonly keys: Record<string, string>;
  private readonly version: number;

  constructor(config: KeyProviderConfig = env) {
    this.keys = config.ENC_KEYS;
    this.version = config.ENC_ACTIVE_VERSION;
  }

  getKey(version: number): Buffer {
    return decodeKey(version, this.keys[String(version)]);
  }

  activeVersion(): number {
    return this.version;
  }
}

export class KmsKeyProvider implements KeyProvider {
  getKey(): Buffer {
    throw new Error('not implemented');
  }

  activeVersion(): number {
    throw new Error('not implemented');
  }
}