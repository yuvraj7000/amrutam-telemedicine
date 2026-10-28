import type { Request, Response } from 'express';
import type { AvailabilityService } from './availability.service.js';
export class AvailabilityController {
  constructor(private readonly service: AvailabilityService) {}
  create = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.create(req.user!, req.body, req.header('Idempotency-Key'));
    if (result.replay) res.setHeader('Idempotent-Replayed', 'true');
    res.status(201).json({ created: result.created, skipped: result.skipped });
  };
  listMine = async (req: Request, res: Response): Promise<void> => {
    res.json(
      await this.service.listMine(
        req.user!,
        String(req.query.from),
        String(req.query.to),
        typeof req.query.status === 'string' ? req.query.status : undefined,
      ),
    );
  };
  publicAvailability = async (req: Request, res: Response): Promise<void> => {
    res.json(
      await this.service.publicAvailability(
        String(req.params.doctorId),
        String(req.query.from),
        String(req.query.to),
      ),
    );
  };
  delete = async (req: Request, res: Response): Promise<void> => {
    await this.service.delete(req.user!, String(req.params.id));
    res.status(204).send();
  };
}
