import type { Request, Response } from 'express';
import type { AuthService } from './auth.service.js';
export class AuthController {
  constructor(private readonly authService: AuthService) {}
  register = async (req: Request, res: Response): Promise<void> => { const user = await this.authService.register(req.body); res.status(201).json({ id: user.id, email: user.email, role: user.role, status: user.status, mfaEnrollmentRequired: false }); };
  login = async (req: Request, res: Response): Promise<void> => {
    const result = await this.authService.login(req.body);
    if ('mfaRequired' in result) {
      res.json({ mfaRequired: result.mfaRequired, mfaToken: result.mfaToken });
      return;
    }
    if ('mfaEnrollmentRequired' in result) {
      res.json({ mfaEnrollmentRequired: result.mfaEnrollmentRequired, setupToken: result.setupToken });
      return;
    }
    res.json({ ...result.pair, tokenType: 'Bearer', user: { id: result.user.id, email: result.user.email, role: result.user.role } });
  };
  refresh = async (req: Request, res: Response): Promise<void> => { res.json(await this.authService.refresh(req.body.refreshToken, req.ip, req.get('user-agent'))); };
  logout = async (req: Request, res: Response): Promise<void> => { await this.authService.logout(req.body.refreshToken); res.status(204).send(); };
  logoutAll = async (req: Request, res: Response): Promise<void> => { await this.authService.logoutAll(req.user!.id); res.status(204).send(); };
  changePassword = async (req: Request, res: Response): Promise<void> => { await this.authService.changePassword(req.user!.id, req.body.currentPassword, req.body.newPassword); res.status(204).send(); };
  mfaSetup = async (req: Request, res: Response): Promise<void> => { res.json(await this.authService.setupMfa(req.user!.id)); };
  mfaEnable = async (req: Request, res: Response): Promise<void> => {
    const result = await this.authService.enableMfa(req.user!.id, req.body.code, req.user!.scope === 'mfa_setup');
    res.json({ backupCodes: result.backupCodes, ...(result.pair ? { ...result.pair, tokenType: 'Bearer' } : {}) });
  };
  mfaVerify = async (req: Request, res: Response): Promise<void> => {
    const pair = await this.authService.verifyMfa(req.body.mfaToken, req.body.code, req.body.backupCode);
    res.json({ ...pair, tokenType: 'Bearer' });
  };
  mfaDisable = async (req: Request, res: Response): Promise<void> => {
    await this.authService.disableMfa(req.user!.id, req.body.password, req.body.code);
    res.status(204).send();
  };
}