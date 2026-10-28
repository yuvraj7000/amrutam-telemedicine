import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { authenticator } from 'otplib';
import jwt from 'jsonwebtoken';
import { redis } from '../../src/common/cache/redis.js';
import { EncryptionService } from '../../src/common/crypto/encryption.service.js';
import { hashPassword } from '../../src/common/crypto/hash.js';
import { EnvKeyProvider } from '../../src/common/crypto/key-provider.js';
import { errorHandler } from '../../src/common/middleware/error-handler.js';
import { authenticate, authenticateMfaSetup } from '../../src/common/middleware/auth.js';
import { requireMfaStepUp } from '../../src/common/middleware/rbac.js';
import { ERROR_CODES } from '../../src/common/errors/index.js';
import { AuthRepository, type UserRow } from '../../src/modules/auth/auth.repository.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { TokenService } from '../../src/modules/auth/token.service.js';

jest.mock('../../src/common/cache/redis.js', () => ({
  redis: { eval: jest.fn(), set: jest.fn(), del: jest.fn(), get: jest.fn() },
}));

class MemoryAuthRepository extends AuthRepository {
  constructor(
    readonly user: UserRow,
    private backupHashes: string[] = [],
  ) {
    super();
  }

  override async findUser(): Promise<UserRow> {
    return this.user;
  }
  override async findById(): Promise<UserRow> {
    return this.user;
  }
  override async resetFailures(): Promise<void> {}
  override async recordFailure(): Promise<void> {}
  override async saveRefresh(): Promise<void> {}
  override async refresh() {
    return {
      id: 'refresh-1',
      user_id: this.user.id,
      family_id: 'family-1',
      revoked_at: null,
      expires_at: new Date(Date.now() + 60_000),
    };
  }
  override async revokeToken(): Promise<void> {}
  override async setMfaSecret(_id: string, encryptedSecret: string): Promise<void> {
    this.user.mfa_secret_enc = encryptedSecret;
  }
  override async enableMfa(_id: string, hashes: string[]): Promise<void> {
    this.backupHashes = hashes;
    this.user.mfa_enabled = true;
    this.user.tokens_valid_after = new Date();
  }
  override async consumeBackupCode(
    _id: string,
    code: string,
    verify: (hash: string, value: string) => Promise<boolean>,
  ): Promise<boolean> {
    for (const [index, hash] of this.backupHashes.entries()) {
      if (await verify(hash, code)) {
        this.backupHashes.splice(index, 1);
        return true;
      }
    }
    return false;
  }
}

describe('MFA authentication', () => {
  const tokenService = new TokenService();
  const encryption = new EncryptionService(
    new EnvKeyProvider({
      ENC_KEYS: { '1': Buffer.alloc(32, 7).toString('base64') },
      ENC_ACTIVE_VERSION: 1,
    }),
  );
  const acceptedSteps = new Map<string, number>();
  const consumedChallenges = new Set<string>();

  beforeEach(() => {
    acceptedSteps.clear();
    consumedChallenges.clear();
    jest.mocked(redis.eval).mockImplementation(async (...args) => {
      const key = String(args[2]);
      const step = Number(args[3]);
      const previous = acceptedSteps.get(key);
      if (previous !== undefined && step <= previous) return 0;
      acceptedSteps.set(key, step);
      return 1;
    });
    jest.mocked(redis.set).mockImplementation(async (key) => {
      const challengeKey = String(key);
      if (consumedChallenges.has(challengeKey)) return null;
      consumedChallenges.add(challengeKey);
      return 'OK';
    });
    jest.mocked(redis.del).mockResolvedValue(1);
  });

  async function createDoctor(): Promise<{
    service: AuthService;
    repository: MemoryAuthRepository;
  }> {
    const repository = new MemoryAuthRepository({
      id: 'doctor-1',
      email: 'doctor@example.test',
      phone: null,
      password_hash: await hashPassword('correct horse battery'),
      role: 'DOCTOR',
      status: 'ACTIVE',
      mfa_enabled: false,
      mfa_secret_enc: null,
      failed_login_count: 0,
      locked_until: null,
      tokens_valid_after: new Date(Date.now() - 60_000),
    });
    return { repository, service: new AuthService(repository, tokenService, encryption) };
  }

  it('forces doctor enrollment, encrypts the seed, verifies TOTP, and consumes backup codes once', async () => {
    const { service, repository } = await createDoctor();
    const firstLogin = await service.login({
      email: repository.user.email,
      password: 'correct horse battery',
    });
    expect('mfaEnrollmentRequired' in firstLogin && firstLogin.mfaEnrollmentRequired).toBe(true);
    if (!('setupToken' in firstLogin)) throw new Error('Expected setup token');
    expect(tokenService.verifyScoped(firstLogin.setupToken, 'mfa_setup').sub).toBe(
      repository.user.id,
    );

    const setup = await service.setupMfa(repository.user.id);
    expect(setup.otpauthUrl).toContain('otpauth://totp/');
    expect(setup.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(repository.user.mfa_secret_enc).toMatch(/^v1:/);
    const enrollmentCode = authenticator.generate(setup.secret);
    const enabled = await service.enableMfa(repository.user.id, enrollmentCode, true);
    expect(enabled.backupCodes).toHaveLength(10);
    expect(enabled.pair).toBeDefined();
    expect(repository.user.mfa_enabled).toBe(true);

    const challenge = await service.login({
      email: repository.user.email,
      password: 'correct horse battery',
    });
    expect('mfaRequired' in challenge && challenge.mfaRequired).toBe(true);
    if (!('mfaToken' in challenge)) throw new Error('Expected MFA token');
    const laterStep = Math.floor(Date.now() / 30_000) + 1;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(laterStep * 30_000 + 1_000);
    const code = authenticator.generate(setup.secret);
    let pair: Awaited<ReturnType<AuthService['verifyMfa']>>;
    try {
      pair = await service.verifyMfa(challenge.mfaToken, code);
    } finally {
      clock.mockRestore();
    }
    expect(jwt.decode(pair.accessToken)).toMatchObject({ amr: ['pwd', 'otp'] });
    expect(pair.user).toMatchObject({ id: repository.user.id, role: 'DOCTOR' });
    const refreshedPair = await service.refresh('refresh-token');
    expect(jwt.decode(refreshedPair.accessToken)).toMatchObject({ amr: ['pwd', 'otp'] });
    await expect(service.verifyMfa(challenge.mfaToken, code)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_MFA_CODE,
    });

    const backupChallenge = await service.login({
      email: repository.user.email,
      password: 'correct horse battery',
    });
    if (!('mfaToken' in backupChallenge)) throw new Error('Expected MFA token');
    const backupPair = await service.verifyMfa(
      backupChallenge.mfaToken,
      undefined,
      enabled.backupCodes[0],
    );
    expect(jwt.decode(backupPair.accessToken)).toMatchObject({ amr: ['pwd', 'otp'] });

    const reuseChallenge = await service.login({
      email: repository.user.email,
      password: 'correct horse battery',
    });
    if (!('mfaToken' in reuseChallenge)) throw new Error('Expected MFA token');
    await expect(
      service.verifyMfa(reuseChallenge.mfaToken, undefined, enabled.backupCodes[0]),
    ).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_MFA_CODE,
    });
    await expect(
      encryption.decrypt(
        repository.user.mfa_secret_enc ?? '',
        `users.mfa_secret_enc:${repository.user.id}`,
      ),
    ).resolves.toBe(setup.secret);
  }, 20_000);

  it('rejects setup tokens on ordinary authenticated routes', async () => {
    const setupToken = tokenService.issueScoped(
      { sub: 'doctor-1', role: 'DOCTOR', scope: 'mfa_setup', jti: 'setup-token' },
      300,
    );
    const app = express();
    app.get('/mfa/setup', authenticateMfaSetup, (_req, res) => res.sendStatus(204));
    app.get('/private', authenticate, (_req, res) => res.sendStatus(200));
    app.use(errorHandler);

    jest.mocked(redis.get).mockResolvedValue(new Date(Date.now() - 60_000).toISOString());
    const setupResponse = await request(app)
      .get('/mfa/setup')
      .set('Authorization', `Bearer ${setupToken}`);
    expect(setupResponse.status).toBe(204);

    const response = await request(app)
      .get('/private')
      .set('Authorization', `Bearer ${setupToken}`);
    expect(response.status).toBe(401);
  });

  it('accepts a token issued in the same second as the session-revocation timestamp', async () => {
    const app = express();
    app.get('/private', authenticate, (_req, res) => res.sendStatus(204));
    app.use(errorHandler);
    const accessToken = tokenService.issueAccess({
      sub: 'patient-1',
      role: 'PATIENT',
      sid: 'family-1',
      amr: ['pwd'],
      jti: 'access-token',
    });
    const currentSecond = Math.floor(Date.now() / 1000) * 1000;
    jest.mocked(redis.get).mockResolvedValue(new Date(currentSecond + 999).toISOString());

    const response = await request(app)
      .get('/private')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(response.status).toBe(204);
  });

  it('prevents doctors from disabling MFA', async () => {
    const { service, repository } = await createDoctor();
    await expect(
      service.disableMfa(repository.user.id, 'password', '123456'),
    ).rejects.toMatchObject({
      code: ERROR_CODES.FORBIDDEN,
    });
  });

  it('requires an OTP-authenticated token for MFA step-up routes', () => {
    const nextMock = jest.fn();
    const next = nextMock as NextFunction;
    requireMfaStepUp(
      { user: { id: 'admin-1', role: 'ADMIN', iat: 1, jti: 'jti' } } as Request,
      {} as Response,
      next,
    );
    expect(nextMock.mock.calls[0]?.[0]).toMatchObject({ code: ERROR_CODES.MFA_STEP_UP_REQUIRED });

    nextMock.mockClear();
    requireMfaStepUp(
      {
        user: { id: 'admin-1', role: 'ADMIN', amr: ['pwd', 'otp'], iat: 1, jti: 'jti' },
      } as Request,
      {} as Response,
      next,
    );
    expect(nextMock).toHaveBeenCalledWith();
  });
});
