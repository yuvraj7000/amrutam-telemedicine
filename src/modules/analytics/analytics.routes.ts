import { Router } from 'express';
import { CacheService } from '../../common/cache/cache.service.js';
import { asyncHandler } from '../../common/middleware/async-handler.js';
import { authenticate } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { registry } from '../../openapi/registry.js';
import { AuditRepository } from '../audit/audit.repository.js';
import { auditAdminGuard } from '../audit/audit.service.js';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsRepository } from './analytics.repository.js';
import { AnalyticsService } from './analytics.service.js';
import {
  overviewQuerySchema,
  timeseriesQuerySchema,
  topDoctorsQuerySchema,
} from './analytics.schemas.js';

export function analyticsRoutes(): Router {
  const router = Router();
  const audit = new AuditRepository();
  const controller = new AnalyticsController(
    new AnalyticsService(new AnalyticsRepository(), new CacheService(), audit),
  );
  router.get(
    '/admin/analytics/overview',
    authenticate,
    auditAdminGuard(audit, 'analytics.view'),
    validate({ query: overviewQuerySchema }),
    asyncHandler(controller.overview),
  );
  router.get(
    '/admin/analytics/timeseries',
    authenticate,
    auditAdminGuard(audit, 'analytics.view'),
    validate({ query: timeseriesQuerySchema }),
    asyncHandler(controller.timeseries),
  );
  router.get(
    '/admin/analytics/top-doctors',
    authenticate,
    auditAdminGuard(audit, 'analytics.view'),
    validate({ query: topDoctorsQuerySchema }),
    asyncHandler(controller.topDoctors),
  );
  registry.registerPath({
    method: 'get',
    path: '/admin/analytics/overview',
    request: { query: registry.register('AnalyticsOverviewQuery', overviewQuerySchema) },
    responses: { 200: { description: 'Analytics overview' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/admin/analytics/timeseries',
    request: { query: registry.register('AnalyticsTimeseriesQuery', timeseriesQuerySchema) },
    responses: { 200: { description: 'Analytics time series' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/admin/analytics/top-doctors',
    request: { query: registry.register('AnalyticsTopDoctorsQuery', topDoctorsQuerySchema) },
    responses: { 200: { description: 'Top doctors by requested metric' } },
  });
  return router;
}
