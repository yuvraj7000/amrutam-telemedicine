import type { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { UnauthorizedError } from '../errors/index.js';
import { redis } from '../cache/redis.js';

export type AuthUser = {
  id: string;
  role: string;
  sid?: string;
  amr?: string[];
  scope?: string;
  iat: number;
  jti: string;
};
declare global {
  // Express's Request interface is augmented for the request-scoped identity.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
export const publicRoute: RequestHandler & { isPublic?: true } = (_req, _res, next) => next();
publicRoute.isPublic = true;
export const publicMarker = publicRoute;

function authenticateScopes(allowSetupScope: boolean): RequestHandler & { requiresAuth?: true } {
  const handler: RequestHandler & { requiresAuth?: true } = async (
    req: Request,
    _res: Response,
    next: NextFunction,
  ) => {
    try {
      const header = req.header('authorization');
      if (!header?.startsWith('Bearer ')) throw new UnauthorizedError();
      const token = header.slice(7);
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || typeof decoded === 'string') throw new UnauthorizedError();
      const kid = decoded.header.kid;
      if (typeof kid !== 'string' || !env.JWT_KEYS[kid]) throw new UnauthorizedError();
      const payload = jwt.verify(token, env.JWT_KEYS[kid], {
        algorithms: ['HS256'],
        audience: 'amrutam-api',
        issuer: 'amrutam',
      }) as JwtPayload;
      const setupToken = payload.scope === 'mfa_setup';
      const validAccessToken =
        payload.scope === undefined &&
        typeof payload.sid === 'string' &&
        Array.isArray(payload.amr) &&
        payload.amr.every((value) => typeof value === 'string');
      const validSetupToken = allowSetupScope && setupToken;
      if (
        typeof payload.sub !== 'string' ||
        typeof payload.role !== 'string' ||
        typeof payload.jti !== 'string' ||
        typeof payload.iat !== 'number' ||
        (!validAccessToken && !validSetupToken)
      )
        throw new UnauthorizedError();
      const key = `user:${payload.sub}:tva`;
      const cached = await redis.get(key);
      if (cached) {
        if (payload.iat < Math.floor(new Date(cached).getTime() / 1000))
          throw new UnauthorizedError();
      } else {
        const { primaryPool } = await import('../db/kysely.js');
        const result = await primaryPool.query<{ tokens_valid_after: Date }>(
          'SELECT tokens_valid_after FROM users WHERE id=$1 AND deleted_at IS NULL',
          [payload.sub],
        );
        const tva = result.rows[0]?.tokens_valid_after;
        if (!tva || payload.iat < Math.floor(tva.getTime() / 1000)) throw new UnauthorizedError();
        await redis.set(key, tva.toISOString(), 'EX', 60);
      }
      req.user = {
        id: payload.sub,
        role: payload.role,
        ...(typeof payload.sid === 'string' ? { sid: payload.sid } : {}),
        ...(Array.isArray(payload.amr) ? { amr: payload.amr as string[] } : {}),
        ...(typeof payload.scope === 'string' ? { scope: payload.scope } : {}),
        iat: payload.iat,
        jti: payload.jti,
      };
      next();
    } catch (error) {
      next(error instanceof UnauthorizedError ? error : new UnauthorizedError());
    }
  };
  handler.requiresAuth = true;
  return handler;
}

export const authenticate = authenticateScopes(false);
export const authenticateMfaSetup = authenticateScopes(true);
