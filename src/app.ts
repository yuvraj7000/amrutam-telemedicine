import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import hpp from 'hpp';

import { errorHandler } from './common/middleware/error-handler.js';
import { notFound } from './common/middleware/not-found.js';
import { requestId } from './common/middleware/request-id.js';
import { httpLogger } from './common/observability/logger.js';
import { env } from './config/env.js';

export function createApp(): express.Express {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(httpLogger);
  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true,
    }),
  );
  app.use(hpp());
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  app.get('/health/ready', (_req, res) => {
    res.status(200).json({ status: 'ready' });
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
