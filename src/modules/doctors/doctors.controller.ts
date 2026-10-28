import type { Request, Response } from 'express';
import { NotFoundError } from '../../common/errors/index.js';
import type { DoctorsService } from './doctors.service.js';

export class DoctorsController {
  constructor(private readonly service: DoctorsService) {}
  updateMe = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.updateProfile(req.user!, req.body));
  };
  search = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.search(req.query as never, req.user));
  };
  getById = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.service.getById(String(req.params.id), req.user));
  };
  verify = async (req: Request, res: Response): Promise<void> => {
    const result = await this.service.setVerification(
      String(req.params.id),
      req.body.status,
      req.user!.id,
      req.body.note,
    );
    if (!result) throw new NotFoundError();
    res.json(result);
  };
}
