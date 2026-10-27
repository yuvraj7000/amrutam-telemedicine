import express from 'express';
import type { DestinationStream } from 'pino';
import request from 'supertest';
import { z } from 'zod';

import { createApp } from '../../src/app.js';
import { parseEnv } from '../../src/config/env.js';
import { ERROR_CODES, NotFoundError } from '../../src/common/errors/index.js';
import { errorHandler } from '../../src/common/middleware/error-handler.js';
import { requestId } from '../../src/common/middleware/request-id.js';
import { createLogger } from '../../src/common/observability/logger.js';
import { validate } from '../../src/common/middleware/validate.js';

describe('foundation', () => {
  it('rejects invalid environment configuration with actionable details', () => {
    expect(() => parseEnv({ DATABASE_URL: 'not-a-url' })).toThrow(
      /Invalid environment configuration/,
    );
    expect(() => parseEnv({ DATABASE_URL: 'not-a-url' })).toThrow(/REDIS_URL/);
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

  it('echoes a generated request id when one is not supplied', async () => {
    const response = await request(createApp()).get('/health/live');
    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toEqual(expect.any(String));
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
