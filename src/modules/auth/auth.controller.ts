import type { Request, Response } from 'express';
import type { AuthService } from './auth.service.js';
export class AuthController {
  constructor(private readonly authService: AuthService) {}
  register = async (req: Request, res: Response): Promise<void> => { const user = await this.authService.register(req.body); res.status(201).json({ id: user.id, email: user.email, role: user.role, status: user.status, mfaEnrollmentRequired: false }); };
  login = async (req: Request, res: Response): Promise<void> => { const result = await this.authService.login(req.body); res.json({ ...result.pair, tokenType: 'Bearer', user: { id: result.user.id, email: result.user.email, role: result.user.role } }); };
  refresh = async (req: Request, res: Response): Promise<void> => { res.json(await this.authService.refresh(req.body.refreshToken, req.ip, req.get('user-agent'))); };
  logout = async (req: Request, res: Response): Promise<void> => { await this.authService.logout(req.body.refreshToken); res.status(204).send(); };
  logoutAll = async (req: Request, res: Response): Promise<void> => { await this.authService.logoutAll(req.user!.id); res.status(204).send(); };
  changePassword = async (req: Request, res: Response): Promise<void> => { await this.authService.changePassword(req.user!.id, req.body.currentPassword, req.body.newPassword); res.status(204).send(); };
  forgot = async (req: Request, res: Response): Promise<void> => { await this.authService.forgot(req.body.email); res.status(202).send(); };
  reset = async (req: Request, res: Response): Promise<void> => { await this.authService.reset(req.body.token, req.body.newPassword); res.status(204).send(); };
}