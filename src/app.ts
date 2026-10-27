import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import hpp from 'hpp';

import { errorHandler } from './common/middleware/error-handler.js';
import { notFound } from './common/middleware/not-found.js';
import { requestId } from './common/middleware/request-id.js';
import { httpLogger } from './common/observability/logger.js';
import { metricsHandler, metricsMiddleware } from './common/observability/metrics.js';
import { checkDatabase } from './common/db/kysely.js';
import { checkRedis } from './common/cache/redis.js';
import { env } from './config/env.js';
import { container, createRequestScope } from './container.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { usersRoutes } from './modules/users/users.routes.js';
import { buildOpenApiDocument } from './openapi/build-document.js';
import { publicRoute } from './common/middleware/auth.js';

let shuttingDown = false;

export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

export function createApp(): express.Express {
  const app = express();
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(httpLogger);
  app.use(metricsMiddleware);
  app.use((req, res, next) => {
    const scope = createRequestScope(container);
    res.locals.container = scope;
    (req as express.Request & { scope: typeof scope }).scope = scope;
    next();
  });
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

  app.use('/api/v1/auth', authRoutes());
  app.use('/api/v1/users', usersRoutes());
  app.get('/health/live', publicRoute, (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  app.get('/health/ready', publicRoute, async (_req, res) => {
    if (shuttingDown) {
      res.status(503).json({ status: 'shutting_down' });
      return;
    }
    const checks = await Promise.allSettled([checkDatabase(), checkRedis()]);
    const ready = checks.every((check) => check.status === 'fulfilled');
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: {
        postgres: checks[0]?.status === 'fulfilled' ? 'ok' : 'error',
        redis: checks[1]?.status === 'fulfilled' ? 'ok' : 'error',
      },
    });
  });
  app.get('/metrics', publicRoute, metricsHandler);

  app.get('/openapi.json', publicRoute, (_req, res) => res.json(buildOpenApiDocument()));
  assertRouteMetadata(app);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

type LayerLike = { route?: { stack?: Array<{ handle: RequestHandlerLike }>; path?: string }; handle?: LayerLike & RequestHandlerLike; name?: string };
type RequestHandlerLike = { isPublic?: boolean; requiresAuth?: boolean; requiredRoles?: readonly string[]; stack?: LayerLike[] };

function assertRouteMetadata(app: express.Express): void {
  const stack = (app as express.Express & { _router?: { stack?: LayerLike[] } })._router?.stack ?? [];
  const visit = (layers: LayerLike[]): void => {
    for (const layer of layers) {
      if (layer.route?.stack) {
        if (!layer.route.stack.some((entry) => entry.handle.isPublic || entry.handle.requiresAuth || entry.handle.requiredRoles)) {
          throw new Error(`Route ${layer.route.path ?? 'unknown'} has no auth/public marker`);
        }
      } else if (layer.handle?.stack) visit(layer.handle.stack);
    }
  };
  visit(stack);
}
