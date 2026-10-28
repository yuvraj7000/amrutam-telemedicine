import { Router } from 'express';
import { asyncHandler } from '../../common/middleware/async-handler.js';
import { authenticate, authenticateMfaSetup, publicRoute } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { accountRateLimiter, ipRateLimiter } from '../../common/middleware/rate-limit.js';
import { sha256 } from '../../common/crypto/hash.js';
import {
  changePasswordSchema,
  disableMfaSchema,
  enableMfaSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  verifyMfaSchema,
} from './auth.schemas.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthRepository } from './auth.repository.js';
import { TokenService } from './token.service.js';
import { env } from '../../config/env.js';
import { registry } from '../../openapi/registry.js';
import { container } from '../../container.js';
import type { EncryptionService } from '../../common/crypto/encryption.service.js';
const authRateLimit = ipRateLimiter(60_000, env.RL_AUTH_PER_MIN, 'rl:auth:ip');
const loginEmailRateLimit = accountRateLimiter(
  60_000,
  env.RL_AUTH_PER_MIN,
  'rl:auth:account',
  (req) =>
    sha256(
      String(req.body?.email ?? 'unknown')
        .trim()
        .toLowerCase(),
    ),
);
export function authRoutes(): Router {
  const router = Router();
  const controller = new AuthController(
    new AuthService(
      new AuthRepository(),
      new TokenService(),
      container.resolve<EncryptionService>('encryptionService'),
    ),
  );
  router.post(
    '/register',
    authRateLimit,
    publicRoute,
    validate({ body: registerSchema }),
    asyncHandler(controller.register),
  );
  router.post(
    '/login',
    authRateLimit,
    loginEmailRateLimit,
    publicRoute,
    validate({ body: loginSchema }),
    asyncHandler(controller.login),
  );
  router.post('/mfa/setup', authRateLimit, authenticateMfaSetup, asyncHandler(controller.mfaSetup));
  router.post(
    '/mfa/enable',
    authRateLimit,
    authenticateMfaSetup,
    validate({ body: enableMfaSchema }),
    asyncHandler(controller.mfaEnable),
  );
  router.post(
    '/mfa/verify',
    authRateLimit,
    publicRoute,
    validate({ body: verifyMfaSchema }),
    asyncHandler(controller.mfaVerify),
  );
  router.post(
    '/mfa/disable',
    authRateLimit,
    authenticate,
    validate({ body: disableMfaSchema }),
    asyncHandler(controller.mfaDisable),
  );
  router.post(
    '/refresh',
    authRateLimit,
    publicRoute,
    validate({ body: refreshSchema }),
    asyncHandler(controller.refresh),
  );
  router.post(
    '/logout',
    authenticate,
    validate({ body: refreshSchema }),
    asyncHandler(controller.logout),
  );
  router.post('/logout-all', authenticate, asyncHandler(controller.logoutAll));
  router.post(
    '/password/change',
    authenticate,
    validate({ body: changePasswordSchema }),
    asyncHandler(controller.changePassword),
  );
  const requestByPath = {
    '/register': { name: 'RegisterRequest', schema: registerSchema },
    '/login': { name: 'LoginRequest', schema: loginSchema },
    '/mfa/enable': { name: 'EnableMfaRequest', schema: enableMfaSchema },
    '/mfa/verify': { name: 'VerifyMfaRequest', schema: verifyMfaSchema },
    '/mfa/disable': { name: 'DisableMfaRequest', schema: disableMfaSchema },
    '/refresh': { name: 'RefreshTokenRequest', schema: refreshSchema },
    '/logout': { name: 'LogoutRequest', schema: refreshSchema },
    '/password/change': { name: 'ChangePasswordRequest', schema: changePasswordSchema },
  } as const;
  for (const [path, method] of [
    ['/mfa/setup', 'post'],
    ['/mfa/enable', 'post'],
    ['/mfa/verify', 'post'],
    ['/mfa/disable', 'post'],
    ['/register', 'post'],
    ['/login', 'post'],
    ['/refresh', 'post'],
    ['/logout', 'post'],
    ['/logout-all', 'post'],
    ['/password/change', 'post'],
  ] as const) {
    const bodyDefinition = requestByPath[path as keyof typeof requestByPath];
    registry.registerPath({
      method,
      path: `/auth${path}`,
      ...(bodyDefinition
        ? {
            request: {
              body: {
                required: true,
                content: {
                  'application/json': {
                    schema: registry.register(bodyDefinition.name, bodyDefinition.schema),
                  },
                },
              },
            },
          }
        : {}),
      responses: { 200: { description: 'Success' } },
    });
  }
  return router;
}
