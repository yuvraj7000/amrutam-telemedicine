import type { Request, Response } from 'express';
import { NotFoundError } from '../../common/errors/index.js';
import type { UsersService } from './users.service.js';
export class UsersController {
  constructor(private readonly usersService: UsersService) {}
  getMe = async (req: Request, res: Response): Promise<void> => { const value = await this.usersService.getMe(req.user!.id); if (!value) throw new NotFoundError(); res.json(value); };
  updateMe = async (req: Request, res: Response): Promise<void> => { await this.usersService.updatePhone(req.user!.id, req.body.phone); res.json(await this.usersService.getMe(req.user!.id)); };
  updateProfile = async (req: Request, res: Response): Promise<void> => { res.json(await this.usersService.updateProfile(req.user!.id, req.body)); };
}