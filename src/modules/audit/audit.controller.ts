import type { Request, Response } from 'express';
import { ValidationError } from '../../common/errors/index.js';
import type { AuditContext } from './hash-chain.js';
import type { AuditService } from './audit.service.js';
import type { AuditQueryInput } from './audit.schemas.js';

function requestActor(req: Request): AuditContext {
  return {
    actorId: req.user!.id,
    actorRole: req.user!.role,
    ip: req.ip,
    ...(req.get('user-agent') ? { userAgent: req.get('user-agent') } : {}),
    ...(req.header('x-request-id') ? { requestId: req.header('x-request-id') } : {}),
  };
}

function dateRange(from: string, to: string): { start: Date; end: Date } {
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  if (days < 0 || days >= 31)
    throw new ValidationError('The audit date range must be at most 31 days.');
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof value.createdAt !== 'string' ||
      typeof value.id !== 'string' ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.id)
    ) {
      throw new Error('Invalid cursor');
    }
    return { createdAt: new Date(value.createdAt), id: value.id };
  } catch {
    throw new ValidationError('The audit cursor is invalid.');
  }
}

export class AuditController {
  constructor(private readonly service: AuditService) {}

  list = async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as AuditQueryInput;
    const range = dateRange(query.from, query.to);
    const result = await this.service.list(
      {
        actorId: query.actorId,
        action: query.action,
        resourceType: query.resourceType,
        resourceId: query.resourceId,
        outcome: query.outcome,
        from: range.start,
        to: range.end,
        limit: query.limit,
        cursor: decodeCursor(query.cursor),
      },
      requestActor(req),
    );
    res.json(result);
  };

  verify = async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as { shard: number; from: string; to: string };
    const range = dateRange(query.from, query.to);
    res.json(await this.service.verify(query.shard, range.start, range.end, requestActor(req)));
  };
}
