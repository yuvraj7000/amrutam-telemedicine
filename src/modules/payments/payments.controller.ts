import type { Request, Response } from 'express';
import { AppError, ERROR_CODES } from '../../common/errors/index.js';
import type { PaymentsService } from './payments.service.js';
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}
  getById = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.getById(req.user!, String(req.params.id)));
  };
  refund = async (req: Request, res: Response): Promise<void> => {
    await this.service.refund(
      req.user!,
      String(req.params.id),
      req.body,
      req.header('Idempotency-Key'),
    );
    res.status(202).json({ status: 'REFUND_PENDING' });
  };
  webhook = async (req: Request, res: Response): Promise<void> => {
    const raw = Buffer.isBuffer(req.body) ? req.body : undefined;
    if (!raw) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 400, 'A raw webhook body is required.');
    }
    await this.service.verifyAndApply(raw, req.header('X-Signature'));
    res.json({});
  };
  simulate = async (req: Request, res: Response): Promise<void> => {
    await this.service.simulate(req.user!, String(req.params.id), req.body.outcome);
    res.json({});
  };
}
