import { Router } from 'express';
import { asyncHandler } from '../../common/middleware/async-handler.js';
import { authenticate } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { registry } from '../../openapi/registry.js';
import { AuditController } from './audit.controller.js';
import { AuditRepository } from './audit.repository.js';
import { auditAdminGuard, AuditService } from './audit.service.js';
import { auditQuerySchema, auditVerifySchema } from './audit.schemas.js';

export function auditRoutes(): Router {
  const router = Router();
  const repository = new AuditRepository();
  const controller = new AuditController(new AuditService(repository));
  router.get(
    '/admin/audit-logs/verify',
    authenticate,
    auditAdminGuard(repository, 'audit.verify'),
    validate({ query: auditVerifySchema }),
    asyncHandler(controller.verify),
  );
  router.get(
    '/admin/audit-logs',
    authenticate,
    auditAdminGuard(repository, 'audit.query'),
    validate({ query: auditQuerySchema }),
    asyncHandler(controller.list),
  );
  registry.registerPath({
    method: 'get',
    path: '/admin/audit-logs',
    request: { query: registry.register('AuditLogQuery', auditQuerySchema) },
    responses: { 200: { description: 'Paginated audit entries' } },
  });
  registry.registerPath({
    method: 'get',
    path: '/admin/audit-logs/verify',
    request: { query: registry.register('AuditVerificationQuery', auditVerifySchema) },
    responses: { 200: { description: 'Hash-chain verification result' } },
  });
  return router;
}
