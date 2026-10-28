import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import hpp from 'hpp';
import swaggerUi from 'swagger-ui-express';

import { errorHandler } from './common/middleware/error-handler.js';
import { asyncHandler } from './common/middleware/async-handler.js';
import { notFound } from './common/middleware/not-found.js';
import { requestId } from './common/middleware/request-id.js';
import { ipRateLimiter } from './common/middleware/rate-limit.js';
import { httpLogger } from './common/observability/logger.js';
import { metricsHandler, metricsMiddleware } from './common/observability/metrics.js';
import { checkDatabase } from './common/db/kysely.js';
import { checkRedis } from './common/cache/redis.js';
import { env } from './config/env.js';
import { container, createRequestScope } from './container.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { usersRoutes } from './modules/users/users.routes.js';
import { doctorsRoutes, adminDoctorsRoutes } from './modules/doctors/doctors.routes.js';
import { availabilityRoutes } from './modules/availability/availability.routes.js';
import { consultationsRoutes } from './modules/consultations/consultations.routes.js';
import { paymentsRoutes, devPaymentsRoutes } from './modules/payments/payments.routes.js';
import { prescriptionsRoutes } from './modules/prescriptions/prescriptions.routes.js';
import { auditRoutes } from './modules/audit/audit.routes.js';
import { analyticsRoutes } from './modules/analytics/analytics.routes.js';
import { buildOpenApiDocument } from './openapi/build-document.js';
import { publicRoute } from './common/middleware/auth.js';

let shuttingDown = false;
const globalRateLimit = ipRateLimiter(60_000, env.RL_GLOBAL_PER_MIN, 'rl:global');

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
  app.use(globalRateLimit);
  app.use('/api/v1/payments/webhook', express.raw({ type: 'application/json', limit: '100kb' }));
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  app.use('/api/v1/auth', authRoutes());
  app.use('/api/v1/users', usersRoutes());
  app.use('/api/v1/doctors', doctorsRoutes());
  app.use('/api/v1/admin/doctors', adminDoctorsRoutes());
  app.use('/api/v1/availability', availabilityRoutes());
  app.use('/api/v1/consultations', consultationsRoutes());
  app.use('/api/v1/payments', paymentsRoutes());
  if (env.NODE_ENV !== 'production') {
    app.use('/api/v1/dev/payments', devPaymentsRoutes());
  }
  app.use('/api/v1', prescriptionsRoutes());
  app.use('/api/v1', auditRoutes());
  app.use('/api/v1', analyticsRoutes());
  app.get('/health/live', publicRoute, (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  app.get(
    '/health/ready',
    publicRoute,
    asyncHandler(async (_req, res) => {
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
    }),
  );
  app.get('/metrics', publicRoute, asyncHandler(metricsHandler));

  app.get('/openapi.json', publicRoute, (_req, res) => res.json(buildOpenApiDocument()));
  if (env.NODE_ENV !== 'production') {
    app.use('/docs', publicRoute, swaggerUi.serve, swaggerUi.setup(buildOpenApiDocument()));
  }
  assertRouteMetadata(app);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

type LayerLike = {
  route?: { stack?: Array<{ handle: RequestHandlerLike }>; path?: string };
  handle?: LayerLike & RequestHandlerLike;
  name?: string;
};
type RequestHandlerLike = {
  isPublic?: boolean;
  requiresAuth?: boolean;
  requiredRoles?: readonly string[];
  stack?: LayerLike[];
};

function assertRouteMetadata(app: express.Express): void {
  const stack =
    (app as express.Express & { _router?: { stack?: LayerLike[] } })._router?.stack ?? [];
  const visit = (layers: LayerLike[]): void => {
    for (const layer of layers) {
      if (layer.route?.stack) {
        if (
          !layer.route.stack.some(
            (entry) =>
              entry.handle.isPublic || entry.handle.requiresAuth || entry.handle.requiredRoles,
          )
        ) {
          throw new Error(`Route ${layer.route.path ?? 'unknown'} has no auth/public marker`);
        }
      } else if (layer.handle?.stack) visit(layer.handle.stack);
    }
  };
  visit(stack);
}
