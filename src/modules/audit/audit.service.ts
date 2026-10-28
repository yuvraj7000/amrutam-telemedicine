import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../../common/errors/index.js';
import type { AuditFilters, AuditRepository } from './audit.repository.js';
import type { AuditContext, AuditEntry } from './hash-chain.js';

export function auditAdminGuard(
  repository: AuditRepository,
  action: 'analytics.view' | 'audit.query' | 'audit.verify',
): RequestHandler & { requiredRoles?: readonly string[] } {
  const handler: RequestHandler & { requiredRoles?: readonly string[] } = (req, _res, next) => {
    if (!req.user) return next(new UnauthorizedError());
    if (req.user.role === 'ADMIN') return next();
    const entry: AuditEntry = {
      actorId: req.user.id,
      actorRole: req.user.role,
      action,
      resourceType: action.startsWith('analytics') ? 'analytics' : 'audit_logs',
      outcome: 'DENIED',
      ip: req.ip,
      ...(req.get('user-agent') ? { userAgent: req.get('user-agent') } : {}),
      ...(req.header('x-request-id') ? { requestId: req.header('x-request-id') } : {}),
      metadata: { fields: ['role'] },
    };
    void repository.record(entry).then(
      () => next(new ForbiddenError()),
      (error: unknown) => next(error),
    );
  };
  handler.requiredRoles = ['ADMIN'];
  return handler;
}

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  async list(
    filters: AuditFilters,
    actor: AuditContext,
  ): Promise<{ data: Record<string, unknown>[]; nextCursor: string | null }> {
    await this.repository.record({
      ...actor,
      action: 'audit.query',
      resourceType: 'audit_logs',
      outcome: 'SUCCESS',
      metadata: {
        fields: ['actorId', 'action', 'resourceType', 'resourceId', 'outcome'].filter(
          (field) => filters[field as keyof AuditFilters] !== undefined,
        ),
      },
    });
    return this.repository.list(filters);
  }

  async verify(shard: number, from: Date, to: Date, actor: AuditContext) {
    await this.repository.record({
      ...actor,
      action: 'audit.verify',
      resourceType: 'audit_logs',
      outcome: 'SUCCESS',
      metadata: { fields: ['shard', 'from', 'to'] },
    });
    return { shard, ...(await this.repository.verify(shard, from, to)) };
  }
}
