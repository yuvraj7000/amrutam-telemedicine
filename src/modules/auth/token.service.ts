import { randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { sha256 } from '../../common/crypto/hash.js';
export type AccessClaims = { sub: string; role: string; sid: string; amr: string[]; jti: string };
export class TokenService {
  issueAccess(claims: AccessClaims): string {
    return jwt.sign(claims, env.JWT_KEYS[env.JWT_ACTIVE_KID] as string, { algorithm: 'HS256', keyid: env.JWT_ACTIVE_KID, audience: 'amrutam-api', issuer: 'amrutam', expiresIn: env.JWT_ACCESS_TTL_SEC });
  }
  issueRefresh(): { token: string; hash: string } { const token = randomBytes(32).toString('base64url'); return { token, hash: sha256(token) }; }
  sessionId(): string { return randomUUID(); }
}