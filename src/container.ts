import { asClass, asFunction, asValue, createContainer, InjectionMode } from 'awilix';

import { CacheService } from './common/cache/cache.service.js';
import { EncryptionService } from './common/crypto/encryption.service.js';
import { createKeyProvider, type KeyProvider } from './common/crypto/key-provider.js';
import { env } from './config/env.js';

export function createAppContainer() {
  const container = createContainer({ injectionMode: InjectionMode.CLASSIC });
  container.register({
    cacheService: asClass(CacheService).singleton(),
    env: asValue(env),
    keyProvider: asFunction((): KeyProvider => createKeyProvider(env)).singleton(),
    encryptionService: asClass(EncryptionService).singleton(),
  });
  return container;
}

export function createRequestScope(container: ReturnType<typeof createAppContainer>) {
  return container.createScope();
}

export const container = createAppContainer();
