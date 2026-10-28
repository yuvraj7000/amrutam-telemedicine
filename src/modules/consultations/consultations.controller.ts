import type { Request, Response } from 'express';
import type { ConsultationsService } from './consultations.service.js';
export class ConsultationsController {
  constructor(private readonly service: ConsultationsService) {}
  book = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.book(req.user!, req.header('Idempotency-Key'), req.body);
    if (result.replay) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  };
  list = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.list(req.user!, req.query as never));
  };
  getById = async (req: Request, res: Response): Promise<void> => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await this.service.getById(req.user!, String(req.params.id)));
  };
  cancel = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.change(req.user!, String(req.params.id), 'CANCEL', {
      reason: req.body.reason,
      idempotencyKey: req.header('Idempotency-Key'),
      requestBody: req.body,
    });
    if (result.replay) res.setHeader('Idempotent-Replayed', 'true');
    res.json(result.body);
  };
  start = async (req: Request, res: Response): Promise<void> => {
    res.json((await this.service.change(req.user!, String(req.params.id), 'START')).body);
  };
  complete = async (req: Request, res: Response): Promise<void> => {
    res.json(
      (
        await this.service.change(req.user!, String(req.params.id), 'COMPLETE', {
          notes: req.body.notes,
        })
      ).body,
    );
  };
  noShow = async (req: Request, res: Response): Promise<void> => {
    res.json((await this.service.change(req.user!, String(req.params.id), 'NO_SHOW')).body);
  };
}
