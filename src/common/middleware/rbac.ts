import type { RequestHandler } from 'express';
import { ERROR_CODES, ForbiddenError, UnauthorizedError } from '../errors/index.js';
export function requireRole(...roles: string[]): RequestHandler & { requiredRoles?: readonly string[] } {
  const handler: RequestHandler & { requiredRoles?: readonly string[] } = (req, _res, next) => {
    if (!req.user) return next(new UnauthorizedError());
    if (!roles.includes(req.user.role)) return next(new ForbiddenError());
    return next();
  };
  handler.requiredRoles = roles;
  return handler;
}
export const requireMfaStepUp: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(new UnauthorizedError());
  if (!req.user.amr?.includes('otp')) {
    return next(new ForbiddenError(ERROR_CODES.MFA_STEP_UP_REQUIRED, 'Multi-factor authentication is required for this action.'));
  }
  return next();
};