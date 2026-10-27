import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { sha256 } from '../../common/crypto/hash.js';
export type AccessClaims = { sub: string; role: string; sid: string; amr: string[]; jti: string };
export type ScopedClaims = { sub: string; role: string; scope: 'mfa' | 'mfa_setup'; jti: string };
export class TokenService {
  issueAccess(claims: AccessClaims): string {
    return jwt.sign(claims, env.JWT_KEYS[env.JWT_ACTIVE_KID] as string, { algorithm: 'HS256', keyid: env.JWT_ACTIVE_KID, audience: 'amrutam-api', issuer: 'amrutam', expiresIn: env.JWT_ACCESS_TTL_SEC });
  }
  issueScoped(claims: ScopedClaims, expiresIn: number): string {
    return jwt.sign(claims, env.JWT_KEYS[env.JWT_ACTIVE_KID] as string, {
      algorithm: 'HS256',
      keyid: env.JWT_ACTIVE_KID,
      audience: 'amrutam-api',
      issuer: 'amrutam',
      expiresIn,
    });
  }
  verifyScoped(token: string, scope: ScopedClaims['scope']): jwt.JwtPayload {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') throw new jwt.JsonWebTokenError('Invalid token');
    const kid = decoded.header.kid;
    if (typeof kid !== 'string' || !env.JWT_KEYS[kid]) throw new jwt.JsonWebTokenError('Invalid key');
    const payload = jwt.verify(token, env.JWT_KEYS[kid] as string, {
      algorithms: ['HS256'],
      audience: 'amrutam-api',
      issuer: 'amrutam',
    });
    if (typeof payload === 'string' || payload.scope !== scope || typeof payload.sub !== 'string' ||
      typeof payload.role !== 'string' || typeof payload.jti !== 'string' || typeof payload.iat !== 'number') {
      throw new jwt.JsonWebTokenError('Invalid scoped token');
    }
    return payload;
  }
  issueRefresh(): { token: string; hash: string } { const token = randomBytes(32).toString('base64url'); return { token, hash: sha256(token) }; }
  sessionId(): string { return randomUUID(); }
}