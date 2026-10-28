import { createServer } from 'node:http';

import { checkDatabase, closeDatabase } from './common/db/kysely.js';
import { checkRedis, closeRedis } from './common/cache/redis.js';
import { stopTracing, startTracing } from './common/observability/tracing.js';
import { env } from './config/env.js';
import { logger } from './common/observability/logger.js';
import { container } from './container.js';
import type { KeyProvider } from './common/crypto/key-provider.js';

let shuttingDown = false;

async function startServer(): Promise<void> {
  await Promise.all([checkDatabase(), checkRedis()]);

  const { createApp, setShuttingDown } = await import('./app.js');
  startTracing();
  const server = createServer(createApp());

  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    setShuttingDown(true);
    logger.info({ signal }, 'Graceful shutdown started');
    server.close((error) => {
      if (error) {
        logger.error({ err: error }, 'Graceful shutdown failed');
        process.exitCode = 1;
        return;
      }
      void Promise.all([closeDatabase(), closeRedis(), stopTracing()])
        .then(() => logger.info('Graceful shutdown completed'))
        .catch((shutdownError: unknown) => {
          logger.error({ err: shutdownError }, 'Graceful shutdown cleanup failed');
          process.exitCode = 1;
        });
      container.resolve<KeyProvider>('keyProvider').close?.();
    });
  }

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));

  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, 'API server started');
  });
}

void startServer().catch(async (error: unknown) => {
  logger.fatal({ err: error }, 'API startup failed');
  process.exitCode = 1;
  const cleanup = await Promise.allSettled([closeDatabase(), closeRedis(), stopTracing()]);
  for (const result of cleanup) {
    if (result.status === 'rejected') {
      logger.error({ err: result.reason }, 'API startup cleanup failed');
    }
  }
  container.resolve<KeyProvider>('keyProvider').close?.();
});
