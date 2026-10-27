import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../errors/index.js';
export function requireRole(...roles: string[]): RequestHandler & { requiredRoles?: readonly string[] } {
  const handler: RequestHandler & { requiredRoles?: readonly string[] } = (req, _res, next) => {
    if (!req.user) return next(new UnauthorizedError());
    if (!roles.includes(req.user.role)) return next(new ForbiddenError());
    return next();
  };
  handler.requiredRoles = roles;
  return handler;
}