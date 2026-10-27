import { createServer } from 'node:http';

import { createApp, setShuttingDown } from './app.js';
import { closeDatabase } from './common/db/kysely.js';
import { closeRedis } from './common/cache/redis.js';
import { stopTracing, startTracing } from './common/observability/tracing.js';
import { env } from './config/env.js';
import { logger } from './common/observability/logger.js';

const server = createServer(createApp());
let shuttingDown = false;
startTracing();

server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'API server started');
});

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
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
