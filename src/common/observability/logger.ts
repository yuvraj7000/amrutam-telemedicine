import pino, { type DestinationStream, type LoggerOptions } from 'pino';
import pinoHttp from 'pino-http';
import type { Response } from 'express';
import { env } from '../../config/env.js';

export const redactionPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.token',
  '*.refreshToken',
  '*.code',
  '*.secret',
  '*.reason',
  '*.notes',
  '*.diagnosis',
  '*.payload',
  'password',
  'token',
  'refreshToken',
  'code',
  'secret',
  'reason',
  'notes',
  'diagnosis',
  'payload',
] as const;

export function createLogger(destination?: DestinationStream): pino.Logger {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: {
      paths: [...redactionPaths],
      censor: '[REDACTED]',
    },
    base: undefined,
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
export const httpLogger = pinoHttp({
  logger,
  customProps: (req, res) => ({
    requestId: (res as Response).locals.requestId ?? req.id,
  }),
});
