import { randomUUID } from 'node:crypto';
import express from 'express';
import type { DestinationStream } from 'pino';
import request from 'supertest';
import { z } from 'zod';

import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { ERROR_CODES, NotFoundError, UnauthorizedError } from '../../src/common/errors/index.js';
import { asyncHandler } from '../../src/common/middleware/async-handler.js';
import { errorHandler } from '../../src/common/middleware/error-handler.js';
import { requestId } from '../../src/common/middleware/request-id.js';
import { createLogger } from '../../src/common/observability/logger.js';
import { validate } from '../../src/common/middleware/validate.js';
import { createRateLimiter } from '../../src/common/middleware/rate-limit.js';
import { buildOpenApiDocument } from '../../src/openapi/build-document.js';

describe('foundation', () => {
  it('generates reusable OpenAPI request schemas from route validators', () => {
    const app = createApp();
    expect(app).toBeDefined();
    const document = buildOpenApiDocument();

    expect(document.components.schemas).toHaveProperty('RegisterRequest');
    expect(document.components.schemas).toHaveProperty('BookConsultationRequest');
    expect(document.components.schemas).toHaveProperty('IssuePrescriptionRequest');
    expect(document.paths['/consultations']?.post?.requestBody).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/BookConsultationRequest' },
        },
      },
    });
  });

  it('rejects invalid environment configuration with actionable details', () => {
    expect(() => parseEnv({ DATABASE_URL: 'not-a-url' })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => parseEnv({ DATABASE_URL: 'not-a-url' })).toThrow(/REDIS_URL/);
  });

  it('allows KMS-backed encryption without environment key material', () => {
    const config = parseEnv({
      ...process.env,
      ENC_KEYS: undefined,
      KMS_KEY_ID: 'alias/amrutam-data',
    });

    expect(config.ENC_KEYS).toBeUndefined();
    expect(config.KMS_KEY_ID).toBe('alias/amrutam-data');
  });

  it('allows both local frontend loopback hostnames outside production', () => {
    const config = parseEnv({
      ...process.env,
      NODE_ENV: 'development',
      CORS_ORIGINS: 'http://localhost:5173',
    });

    expect(config.CORS_ORIGINS).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });

  it('maps application errors to RFC 9457 problem details', async () => {
    const app = createApp();
    const response = await request(app).get('/missing').set('X-Request-Id', 'request-123');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body).toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
      status: 404,
      requestId: 'request-123',
    });

    expect(response.body.detail).toContain('No route matches');
  });

  it('forwards rejected async handlers to Express error middleware', async () => {
    const app = express();
    app.use(requestId);
    app.post(
      '/login',
      asyncHandler(async () => {
        throw new UnauthorizedError(ERROR_CODES.INVALID_CREDENTIALS, 'Invalid email or password.');
      }),
    );
    app.use(errorHandler);

    const response = await request(app).post('/login');

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body).toMatchObject({
      code: ERROR_CODES.INVALID_CREDENTIALS,
      detail: 'Invalid email or password.',
    });
  });

  it('redacts sensitive values from structured logs', async () => {
    const lines: string[] = [];
    const stream: DestinationStream = {
      write(chunk: string) {
        lines.push(chunk);
        return true;
      },
    };
    const testLogger = createLogger(stream);

    testLogger.info(
      {
        password: 'password-value',
        token: 'token-value',
        reason: 'clinical reason',
        nested: { secret: 'secret-value' },
        safe: 'visible',
      },
      'test log',
    );

    await new Promise<void>((resolve, reject) => {
      testLogger.flush((error) => (error ? reject(error) : resolve()));
    });
    const line = lines.join('');
    expect(line).not.toContain('password-value');
    expect(line).not.toContain('token-value');
    expect(line).not.toContain('clinical reason');
    expect(line).not.toContain('secret-value');
    expect(line).toContain('[REDACTED]');
    expect(line).toContain('visible');
  });

  it('validates strict request input', async () => {
    const app = express();
    app.use(requestId);
    app.use(express.json());
    app.post(
      '/test-validation',
      validate({ body: z.object({ name: z.string() }).strict() }),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    app.use(errorHandler);

    const response = await request(app)
      .post('/test-validation')
      .send({ name: 'Asha', extra: true });
    expect(response.status).toBe(422);
    expect(response.body.code).toBe(ERROR_CODES.VALIDATION_ERROR);
  });

  it('returns problem details and Retry-After when the local rate-limit fallback is exceeded', async () => {
    const app = express();
    app.use(requestId);
    app.use(
      createRateLimiter({
        windowMs: 60_000,
        limit: 1,
        prefix: `test:${randomUUID()}`,
      }),
    );
    app.get('/limited', (_req, res) => res.sendStatus(204));
    app.use(errorHandler);

    expect((await request(app).get('/limited')).status).toBe(204);
    const response = await request(app).get('/limited');

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
    expect(response.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(response.body.code).toBe('RATE_LIMITED');
  });

  it('echoes a generated request id when one is not supplied', async () => {
    const response = await request(createApp())
      .get('/health/live')
      .set('Origin', 'http://127.0.0.1:5173');
    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
    expect(response.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
  });

  it('keeps AppError details available to the error handler contract', () => {
    const error = new NotFoundError('missing item');
    expect(error).toMatchObject({
      code: ERROR_CODES.NOT_FOUND,
      status: 404,
      detail: 'missing item',
    });
  });
});
