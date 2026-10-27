import { asClass, createContainer, InjectionMode } from 'awilix';

import { CacheService } from './common/cache/cache.service.js';

export function createAppContainer() {
  const container = createContainer({ injectionMode: InjectionMode.CLASSIC });
  container.register({
    cacheService: asClass(CacheService).singleton(),
  });
  return container;
}

export function createRequestScope(container: ReturnType<typeof createAppContainer>) {
  return container.createScope();
}

export const container = createAppContainer();
