import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword, sha256 } from '../../common/crypto/hash.js';
import { redis } from '../../common/cache/redis.js';
import { authEvents } from '../../common/observability/metrics.js';
import { AppError, ConflictError, ERROR_CODES, UnauthorizedError } from '../../common/errors/index.js';
import { env } from '../../config/env.js';
import type { AuthRepository, UserRow } from './auth.repository.js';
import type { TokenService } from './token.service.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';

const COMMON_PASSWORDS = new Set(['password1234', 'passwordpassword', 'qwertyuiop12', 'letmein12345', 'adminpassword']);
const DUMMY_PASSWORD = 'dummy-password-for-timing-only';
const genericInvalid = () => new UnauthorizedError(ERROR_CODES.INVALID_CREDENTIALS, 'Invalid email or password.');

export class AuthService {
  constructor(private readonly authRepository: AuthRepository, private readonly tokenService: TokenService) {}
  private validatePassword(password: string): void {
    if (COMMON_PASSWORDS.has(password.toLowerCase())) throw new AppError(ERROR_CODES.WEAK_PASSWORD, 422, 'Password is too common.');
  }
  private async pair(user: UserRow, family = randomUUID(), amr = ['pwd']): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const refresh = this.tokenService.issueRefresh();
    await this.authRepository.saveRefresh(user.id, family, refresh.hash, new Date(Date.now() + env.REFRESH_TTL_DAYS * 86400000));
    return { accessToken: this.tokenService.issueAccess({ sub: user.id, role: user.role, sid: family, amr, jti: randomUUID() }), refreshToken: refresh.token, expiresIn: env.JWT_ACCESS_TTL_SEC };
  }
  async register(input: RegisterInput): Promise<UserRow> {
    this.validatePassword(input.password);
    try { return await this.authRepository.register({ ...input, email: input.email.toLowerCase(), passwordHash: await hashPassword(input.password) }); }
    catch (error) {
      if ((error as { code?: string }).code === '23505') throw new ConflictError(ERROR_CODES.EMAIL_TAKEN, 'Email is already registered.');
      throw error;
    }
  }
  async login(input: LoginInput): Promise<{ user: UserRow; pair: Awaited<ReturnType<AuthService['pair']>> }> {
    const user = await this.authRepository.findUser(input.email.toLowerCase());
    if (!user) { await hashPassword(DUMMY_PASSWORD); throw genericInvalid(); }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      const error = new AppError(ERROR_CODES.ACCOUNT_LOCKED, 423, 'Account is temporarily locked.');
      (error as AppError & { retryAfter?: number }).retryAfter = Math.ceil((user.locked_until.getTime() - Date.now()) / 1000);
      throw error;
    }
    if (user.status === 'SUSPENDED') throw new AppError(ERROR_CODES.ACCOUNT_SUSPENDED, 403, 'Account is suspended.');
    const valid = await verifyPassword(user.password_hash, input.password).catch(() => false);
    if (!valid) { await this.authRepository.recordFailure(user.id, env.LOGIN_MAX_FAILURES, env.LOGIN_LOCK_MINUTES); throw genericInvalid(); }
    await this.authRepository.resetFailures(user.id);
    return { user, pair: await this.pair(user) };
  }
  async refresh(raw: string, ip?: string, agent?: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const old = await this.authRepository.refresh(sha256(raw));
    if (!old || old.expires_at.getTime() <= Date.now()) throw new UnauthorizedError(ERROR_CODES.INVALID_REFRESH_TOKEN, 'Invalid refresh token.');
    if (old.revoked_at) {
      await this.authRepository.revokeFamily(old.family_id);
      console.warn('auth.refresh_reuse_detected', { familyId: old.family_id });
      authEvents.inc({ event: 'refresh_reuse' });
      throw new UnauthorizedError(ERROR_CODES.INVALID_REFRESH_TOKEN, 'Invalid refresh token.');
    }
    const user = await this.authRepository.findById(old.user_id);
    if (!user) throw new UnauthorizedError(ERROR_CODES.INVALID_REFRESH_TOKEN, 'Invalid refresh token.');
    const next = this.tokenService.issueRefresh();
    await this.authRepository.revokeToken(old.id, next.hash);
    await this.authRepository.saveRefresh(user.id, old.family_id, next.hash, new Date(Date.now() + env.REFRESH_TTL_DAYS * 86400000), ip, agent);
    return { accessToken: this.tokenService.issueAccess({ sub: user.id, role: user.role, sid: old.family_id, amr: ['pwd'], jti: randomUUID() }), refreshToken: next.token, expiresIn: env.JWT_ACCESS_TTL_SEC };
  }
  async logout(raw: string): Promise<void> { const token = await this.authRepository.refresh(sha256(raw)); if (token) await this.authRepository.revokeToken(token.id); }
  async logoutAll(id: string): Promise<void> { await this.authRepository.revokeUserTokens(id); await this.authRepository.bumpTva(id); await redis.del(`user:${id}:tva`); }
  async changePassword(id: string, current: string, next: string): Promise<void> {
    this.validatePassword(next); const user = await this.authRepository.findById(id);
    if (!user || !(await verifyPassword(user.password_hash, current).catch(() => false))) throw genericInvalid();
    await this.authRepository.updatePassword(id, await hashPassword(next)); await this.authRepository.revokeUserTokens(id); await redis.del(`user:${id}:tva`);
  }
  async forgot(email: string): Promise<void> {
    const user = await this.authRepository.findUser(email.toLowerCase());
    if (user) { const token = randomBytes(32).toString('base64url'); await redis.set(`password-reset:${sha256(token)}`, user.id, 'EX', 900); console.info('notification would be sent', { userId: user.id }); }
  }
  async reset(token: string, next: string): Promise<void> {
    this.validatePassword(next); const key = `password-reset:${sha256(token)}`; const id = await redis.get(key);
    if (!id) throw new UnauthorizedError(ERROR_CODES.PASSWORD_RESET_INVALID, 'Invalid or expired reset token.');
    await this.authRepository.updatePassword(id, await hashPassword(next)); await this.authRepository.revokeUserTokens(id); await redis.del(key); await redis.del(`user:${id}:tva`);
  }
}