import type { Request, Response } from 'express';
import type { AuditContext } from '../audit/hash-chain.js';
import type { PrescriptionsService } from './prescriptions.service.js';

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

export class PrescriptionsController {
  constructor(private readonly service: PrescriptionsService) {}

  issue = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.issue(
      req.params.consultationId as string,
      actor(req),
      req.user!.role,
      req.body,
    );
    res.status(201).json(result);
  };

  list = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.list(
      req.params.consultationId as string,
      actor(req),
      req.user!.role,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  };

  get = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.get(req.params.id as string, actor(req), req.user!.role);
    res.setHeader('Cache-Control', 'no-store');
    res.json(result);
  };
}
