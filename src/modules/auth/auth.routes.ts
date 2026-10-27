import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authenticate, authenticateMfaSetup, publicRoute } from '../../common/middleware/auth.js';
import { validate } from '../../common/middleware/validate.js';
import { changePasswordSchema, disableMfaSchema, enableMfaSchema, forgotPasswordSchema, loginSchema, refreshSchema, registerSchema, resetPasswordSchema, verifyMfaSchema } from './auth.schemas.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { AuthRepository } from './auth.repository.js';
import { TokenService } from './token.service.js';
import { env } from '../../config/env.js';
import { registry } from '../../openapi/registry.js';
const authRateLimit = rateLimit({ windowMs: 60_000, limit: env.RL_AUTH_PER_MIN, standardHeaders: true });
const loginEmailRateLimit = rateLimit({
  windowMs: 60_000,
  limit: env.RL_AUTH_PER_MIN,
  standardHeaders: true,
  keyGenerator: (req) => String(req.body?.email ?? 'unknown').toLowerCase(),
});
export function authRoutes(): Router {
  const router = Router(); const controller = new AuthController(new AuthService(new AuthRepository(), new TokenService()));
  router.post('/register', authRateLimit, publicRoute, validate({ body: registerSchema }), controller.register);
  router.post('/login', authRateLimit, loginEmailRateLimit, publicRoute, validate({ body: loginSchema }), controller.login);
  router.post('/mfa/setup', authRateLimit, authenticateMfaSetup, controller.mfaSetup);
  router.post('/mfa/enable', authRateLimit, authenticateMfaSetup, validate({ body: enableMfaSchema }), controller.mfaEnable);
  router.post('/mfa/verify', authRateLimit, publicRoute, validate({ body: verifyMfaSchema }), controller.mfaVerify);
  router.post('/mfa/disable', authRateLimit, authenticate, validate({ body: disableMfaSchema }), controller.mfaDisable);
  router.post('/refresh', authRateLimit, publicRoute, validate({ body: refreshSchema }), controller.refresh);
  router.post('/logout', authenticate, validate({ body: refreshSchema }), controller.logout);
  router.post('/logout-all', authenticate, controller.logoutAll);
  router.post('/password/change', authenticate, validate({ body: changePasswordSchema }), controller.changePassword);
  router.post('/password/forgot', authRateLimit, publicRoute, validate({ body: forgotPasswordSchema }), controller.forgot);
  router.post('/password/reset', authRateLimit, publicRoute, validate({ body: resetPasswordSchema }), controller.reset);
  for (const [path, method] of [
    ['/mfa/setup', 'post'], ['/mfa/enable', 'post'], ['/mfa/verify', 'post'], ['/mfa/disable', 'post'],
    ['/register', 'post'], ['/login', 'post'], ['/refresh', 'post'], ['/logout', 'post'], ['/logout-all', 'post'],
    ['/password/change', 'post'], ['/password/forgot', 'post'], ['/password/reset', 'post'],
  ] as const) registry.registerPath({ method, path: `/auth${path}`, responses: { 200: { description: 'Success' } } });
  return router;
}