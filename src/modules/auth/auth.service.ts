import { randomBytes, randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import jwt from 'jsonwebtoken';
import { hashPassword, verifyPassword, sha256 } from '../../common/crypto/hash.js';
import { EncryptionService } from '../../common/crypto/encryption.service.js';
import { createKeyProvider } from '../../common/crypto/key-provider.js';
import { redis } from '../../common/cache/redis.js';
import { authEvents } from '../../common/observability/metrics.js';
import {
  AppError,
  ConflictError,
  ERROR_CODES,
  ForbiddenError,
  UnauthorizedError,
} from '../../common/errors/index.js';
import { env } from '../../config/env.js';
import type { AuthRepository, UserRow } from './auth.repository.js';
import type { TokenService } from './token.service.js';
import type { LoginInput, RegisterInput } from './auth.schemas.js';

authenticator.options = { ...authenticator.options, step: 30, digits: 6, window: 1 };
const COMMON_PASSWORDS = new Set([
  'password1234',
  'passwordpassword',
  'qwertyuiop12',
  'letmein12345',
  'adminpassword',
]);
const DUMMY_PASSWORD = 'dummy-password-for-timing-only';
const genericInvalid = () =>
  new UnauthorizedError(ERROR_CODES.INVALID_CREDENTIALS, 'Invalid email or password.');

export class AuthService {
  constructor(
    private readonly authRepository: AuthRepository,
    private readonly tokenService: TokenService,
    private readonly encryption = new EncryptionService(createKeyProvider(env)),
  ) {}
  private validatePassword(password: string): void {
    if (COMMON_PASSWORDS.has(password.toLowerCase()))
      throw new AppError(ERROR_CODES.WEAK_PASSWORD, 422, 'Password is too common.');
  }
  private async pair(
    user: UserRow,
    family = randomUUID(),
    amr = ['pwd'],
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const refresh = this.tokenService.issueRefresh();
    await this.authRepository.saveRefresh(
      user.id,
      family,
      refresh.hash,
      new Date(Date.now() + env.REFRESH_TTL_DAYS * 86400000),
    );
    return {
      accessToken: this.tokenService.issueAccess({
        sub: user.id,
        role: user.role,
        sid: family,
        amr,
        jti: randomUUID(),
      }),
      refreshToken: refresh.token,
      expiresIn: env.JWT_ACCESS_TTL_SEC,
    };
  }
  async register(input: RegisterInput): Promise<UserRow> {
    this.validatePassword(input.password);
    try {
      return await this.authRepository.register({
        ...input,
        email: input.email.toLowerCase(),
        passwordHash: await hashPassword(input.password),
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        throw new ConflictError(ERROR_CODES.EMAIL_TAKEN, 'Email is already registered.');
      throw error;
    }
  }
  async login(
    input: LoginInput,
  ): Promise<
    | { user: UserRow; pair: Awaited<ReturnType<AuthService['pair']>> }
    | { user: UserRow; mfaRequired: true; mfaToken: string }
    | { user: UserRow; mfaEnrollmentRequired: true; setupToken: string }
  > {
    const user = await this.authRepository.findUser(input.email.toLowerCase());
    if (!user) {
      await hashPassword(DUMMY_PASSWORD);
      throw genericInvalid();
    }
    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      const error = new AppError(ERROR_CODES.ACCOUNT_LOCKED, 423, 'Account is temporarily locked.');
      (error as AppError & { retryAfter?: number }).retryAfter = Math.ceil(
        (user.locked_until.getTime() - Date.now()) / 1000,
      );
      throw error;
    }
    if (user.status === 'SUSPENDED')
      throw new AppError(ERROR_CODES.ACCOUNT_SUSPENDED, 403, 'Account is suspended.');
    const valid = await verifyPassword(user.password_hash, input.password).catch(() => false);
    if (!valid) {
      await this.authRepository.recordFailure(
        user.id,
        env.LOGIN_MAX_FAILURES,
        env.LOGIN_LOCK_MINUTES,
      );
      throw genericInvalid();
    }
    await this.authRepository.resetFailures(user.id);
    if (user.mfa_enabled) {
      return {
        user,
        mfaRequired: true,
        mfaToken: this.tokenService.issueScoped(
          { sub: user.id, role: user.role, scope: 'mfa', jti: randomUUID() },
          env.MFA_TOKEN_TTL_SEC,
        ),
      };
    }
    if (user.role === 'DOCTOR' || user.role === 'ADMIN') {
      return {
        user,
        mfaEnrollmentRequired: true,
        setupToken: this.tokenService.issueScoped(
          { sub: user.id, role: user.role, scope: 'mfa_setup', jti: randomUUID() },
          env.MFA_TOKEN_TTL_SEC,
        ),
      };
    }
    return { user, pair: await this.pair(user) };
  }
  async setupMfa(
    userId: string,
  ): Promise<{ secret: string; otpauthUrl: string; qrDataUrl: string }> {
    const user = await this.authRepository.findById(userId);
    if (!user || user.mfa_enabled)
      throw new ConflictError(ERROR_CODES.INVALID_STATE, 'MFA cannot be set up for this account.');
    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(user.email, env.MFA_ISSUER, secret);
    const qrDataUrl = await QRCode.toDataURL(otpauthUrl);
    await this.authRepository.setMfaSecret(
      user.id,
      await this.encryption.encrypt(secret, `users.mfa_secret_enc:${user.id}`),
    );
    return { secret, otpauthUrl, qrDataUrl };
  }
  async enableMfa(
    userId: string,
    code: string,
    completeLogin = false,
  ): Promise<{
    backupCodes: string[];
    pair?: Awaited<ReturnType<AuthService['pair']>>;
  }> {
    const user = await this.authRepository.findById(userId);
    const secret = await this.decryptMfaSecret(user);
    if (!user || user.mfa_enabled)
      throw new ConflictError(
        ERROR_CODES.INVALID_STATE,
        'MFA is already enabled or has not been set up.',
      );
    if (!(await this.acceptTotpStep(user.id, secret, code))) throw this.invalidMfaCode();

    const backupCodes = Array.from({ length: 10 }, () => {
      const codeValue = randomBytes(5).toString('hex').toUpperCase();
      return `${codeValue.slice(0, 5)}-${codeValue.slice(5)}`;
    });
    const hashes = await Promise.all(backupCodes.map((backupCode) => hashPassword(backupCode)));
    await this.authRepository.enableMfa(user.id, hashes);
    await redis.del(`user:${user.id}:tva`);
    return {
      backupCodes,
      ...(completeLogin ? { pair: await this.pair(user, randomUUID(), ['pwd', 'otp']) } : {}),
    };
  }
  async verifyMfa(
    mfaToken: string,
    code?: string,
    backupCode?: string,
  ): Promise<
    Awaited<ReturnType<AuthService['pair']>> & { user: { id: string; email: string; role: string } }
  > {
    let claims: jwt.JwtPayload;
    try {
      claims = this.tokenService.verifyScoped(mfaToken, 'mfa');
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedError(
          ERROR_CODES.MFA_TOKEN_EXPIRED,
          'The MFA challenge has expired.',
        );
      }
      throw this.invalidMfaCode();
    }
    const user = await this.authRepository.findById(claims.sub as string);
    if (
      !user ||
      !user.mfa_enabled ||
      user.status === 'SUSPENDED' ||
      user.role !== claims.role ||
      typeof claims.iat !== 'number' ||
      claims.iat < Math.floor(user.tokens_valid_after.getTime() / 1000)
    ) {
      throw this.invalidMfaCode();
    }
    let valid = false;
    if (code) {
      const secret = await this.decryptMfaSecret(user);
      valid = await this.acceptTotpStep(user.id, secret, code);
    } else if (backupCode) {
      valid = await this.authRepository.consumeBackupCode(user.id, backupCode, verifyPassword);
    }
    if (!valid) throw this.invalidMfaCode();
    const challengeClaim = await redis.set(
      `mfa:challenge:${claims.jti as string}`,
      '1',
      'EX',
      env.MFA_TOKEN_TTL_SEC,
      'NX',
    );
    if (challengeClaim !== 'OK') throw this.invalidMfaCode();
    return {
      ...(await this.pair(user, randomUUID(), ['pwd', 'otp'])),
      user: { id: user.id, email: user.email, role: user.role },
    };
  }
  async disableMfa(userId: string, password: string, code: string): Promise<void> {
    const user = await this.authRepository.findById(userId);
    if (!user) throw genericInvalid();
    if (user.role === 'DOCTOR' || user.role === 'ADMIN') {
      throw new ForbiddenError(ERROR_CODES.FORBIDDEN, 'MFA cannot be disabled for this account.');
    }
    if (!(await verifyPassword(user.password_hash, password).catch(() => false)))
      throw genericInvalid();
    const secret = await this.decryptMfaSecret(user);
    if (!user.mfa_enabled || !(await this.acceptTotpStep(user.id, secret, code)))
      throw this.invalidMfaCode();
    await this.authRepository.disableMfa(user.id);
    await redis.del(`mfa:last:${user.id}`);
    await redis.del(`user:${user.id}:tva`);
  }
  private async decryptMfaSecret(user: UserRow | undefined): Promise<string> {
    if (!user?.mfa_secret_enc)
      throw new ConflictError(
        ERROR_CODES.INVALID_STATE,
        'MFA has not been set up for this account.',
      );
    return this.encryption.decrypt(user.mfa_secret_enc, `users.mfa_secret_enc:${user.id}`);
  }
  private async acceptTotpStep(userId: string, secret: string, code: string): Promise<boolean> {
    if (!/^\d{6}$/.test(code)) return false;
    const currentStep = Math.floor(Date.now() / 30_000);
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null) return false;
    const matchedStep = currentStep + delta;
    const result = await redis.eval(
      "local previous=redis.call('GET',KEYS[1]); local step=tonumber(ARGV[1]); if previous and step<=tonumber(previous) then return 0 end; redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[2]); return 1",
      1,
      `mfa:last:${userId}`,
      String(matchedStep),
      '90',
    );
    return result === 1;
  }
  private invalidMfaCode(): UnauthorizedError {
    return new UnauthorizedError(ERROR_CODES.INVALID_MFA_CODE, 'Invalid MFA code.');
  }
  async refresh(
    raw: string,
    ip?: string,
    agent?: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const old = await this.authRepository.refresh(sha256(raw));
    if (!old || old.expires_at.getTime() <= Date.now())
      throw new UnauthorizedError(ERROR_CODES.INVALID_REFRESH_TOKEN, 'Invalid refresh token.');
    if (old.revoked_at) {
      await this.authRepository.revokeFamily(old.family_id);
      console.warn('auth.refresh_reuse_detected', { familyId: old.family_id });
      authEvents.inc({ event: 'refresh_reuse' });
      throw new UnauthorizedError(ERROR_CODES.INVALID_REFRESH_TOKEN, 'Invalid refresh token.');
    }
    const user = await this.authRepository.findById(old.user_id);
    if (!user)
      throw new UnauthorizedError(ERROR_CODES.INVALID_REFRESH_TOKEN, 'Invalid refresh token.');
    const next = this.tokenService.issueRefresh();
    await this.authRepository.revokeToken(old.id, next.hash);
    await this.authRepository.saveRefresh(
      user.id,
      old.family_id,
      next.hash,
      new Date(Date.now() + env.REFRESH_TTL_DAYS * 86400000),
      ip,
      agent,
    );
    return {
      accessToken: this.tokenService.issueAccess({
        sub: user.id,
        role: user.role,
        sid: old.family_id,
        amr: user.mfa_enabled ? ['pwd', 'otp'] : ['pwd'],
        jti: randomUUID(),
      }),
      refreshToken: next.token,
      expiresIn: env.JWT_ACCESS_TTL_SEC,
    };
  }
  async logout(raw: string): Promise<void> {
    const token = await this.authRepository.refresh(sha256(raw));
    if (token) await this.authRepository.revokeToken(token.id);
  }
  async logoutAll(id: string): Promise<void> {
    await this.authRepository.revokeUserTokens(id);
    await this.authRepository.bumpTva(id);
    await redis.del(`user:${id}:tva`);
  }
  async changePassword(id: string, current: string, next: string): Promise<void> {
    this.validatePassword(next);
    const user = await this.authRepository.findById(id);
    if (!user || !(await verifyPassword(user.password_hash, current).catch(() => false)))
      throw genericInvalid();
    await this.authRepository.updatePassword(id, await hashPassword(next));
    await this.authRepository.revokeUserTokens(id);
    await redis.del(`user:${id}:tva`);
  }
}
