import type { Request, Response } from 'express';
import type { AuditContext } from '../audit/hash-chain.js';
import type { AnalyticsRangeInput } from './analytics.schemas.js';
import type { AnalyticsService } from './analytics.service.js';

function actor(req: Request): AuditContext {
  const requestId = req.header('x-request-id');
  const userAgent = req.get('user-agent');
  return {
    actorId: req.user!.id,
    actorRole: req.user!.role,
    ip: req.ip,
    ...(requestId ? { requestId } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  overview = async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as AnalyticsRangeInput;
    res.json(await this.service.overview(query, actor(req)));
  };

  timeseries = async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as {
      from: string;
      to: string;
      metric: 'consultations' | 'revenue' | 'cancellations';
      granularity: 'day' | 'week';
    };
    res.json(await this.service.timeseries(query.metric, query.granularity, query, actor(req)));
  };

  topDoctors = async (req: Request, res: Response): Promise<void> => {
    const query = req.query as unknown as {
      from: string;
      to: string;
      by: 'consultations' | 'revenue' | 'rating';
      limit: number;
    };
    res.json(await this.service.topDoctors(query.by, query, query.limit, actor(req)));
  };
}
