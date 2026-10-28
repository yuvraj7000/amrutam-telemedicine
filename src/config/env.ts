import 'dotenv/config';

import { z } from 'zod';

const jsonRecord = z
  .string()
  .min(1)
  .transform((value, context) => {
    try {
      const parsed: unknown = JSON.parse(value);
      const result = z.record(z.string().min(1)).safeParse(parsed);
      if (!result.success) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'must be a JSON object of strings',
        });
        return z.NEVER;
      }
      return result.data;
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid JSON' });
      return z.NEVER;
    }
  });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),
    DATABASE_URL: z.string().url(),
    DATABASE_READ_URL: z.string().url().optional().or(z.literal('')),
    DB_POOL_MAX: z.coerce.number().int().positive().default(20),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    DB_IDLE_IN_TX_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
    REDIS_URL: z.string().url(),
    JWT_KEYS: jsonRecord,
    JWT_ACTIVE_KID: z.string().min(1),
    JWT_ACCESS_TTL_SEC: z.coerce.number().int().positive().default(900),
    REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(14),
    MFA_TOKEN_TTL_SEC: z.coerce.number().int().positive().default(300),
    MFA_ISSUER: z.string().min(1).default('Amrutam'),
    LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
    LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
    ENC_KEYS: jsonRecord.optional(),
    ENC_ACTIVE_VERSION: z.coerce.number().int().positive().default(1),
    KMS_KEY_ID: z.string().optional().or(z.literal('')),
    RL_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(120),
    RL_AUTH_PER_MIN: z.coerce.number().int().positive().default(10),
    RL_BOOKING_PER_MIN: z.coerce.number().int().positive().default(20),
    SLOT_HOLD_MINUTES: z.coerce.number().int().positive().default(10),
    MIN_BOOKING_LEAD_MINUTES: z.coerce.number().int().nonnegative().default(15),
    CANCEL_FULL_REFUND_HOURS: z.coerce.number().int().nonnegative().default(24),
    IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().positive().default(24),
    PAYMENT_PROVIDER: z.enum(['mock', 'razorpay', 'stripe']).default('mock'),
    PAYMENT_WEBHOOK_SECRET: z.string().min(1),
    PAYMENT_API_KEY: z.string().optional().or(z.literal('')),
    PAYMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().default('http://localhost:4318'),
    OTEL_SERVICE_NAME: z.string().min(1).default('amrutam-api'),
    METRICS_TOKEN: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [version, encodedKey] of Object.entries(value.ENC_KEYS ?? {})) {
      const decodedKey = Buffer.from(encodedKey, 'base64');
      if (decodedKey.length !== 32 || decodedKey.toString('base64') !== encodedKey) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ENC_KEYS', version],
          message: 'must be a canonical base64-encoded 32-byte key',
        });
      }
    }
    if (!value.JWT_KEYS[value.JWT_ACTIVE_KID]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACTIVE_KID'],
        message: 'must reference a key in JWT_KEYS',
      });
    }
    if (!value.KMS_KEY_ID && !value.ENC_KEYS?.[String(value.ENC_ACTIVE_VERSION)]) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ENC_ACTIVE_VERSION'],
        message: 'must reference a key in ENC_KEYS when KMS_KEY_ID is not configured',
      });
    }
    if (
      value.NODE_ENV === 'production' &&
      value.CORS_ORIGINS.split(',').some((origin) => origin.trim() === '*')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'must not contain "*" in production',
      });
    }
  });

const envKeys = [
  'NODE_ENV',
  'PORT',
  'LOG_LEVEL',
  'CORS_ORIGINS',
  'TRUST_PROXY',
  'DATABASE_URL',
  'DATABASE_READ_URL',
  'DB_POOL_MAX',
  'DB_STATEMENT_TIMEOUT_MS',
  'DB_IDLE_IN_TX_TIMEOUT_MS',
  'REDIS_URL',
  'JWT_KEYS',
  'JWT_ACTIVE_KID',
  'JWT_ACCESS_TTL_SEC',
  'REFRESH_TTL_DAYS',
  'MFA_TOKEN_TTL_SEC',
  'MFA_ISSUER',
  'LOGIN_MAX_FAILURES',
  'LOGIN_LOCK_MINUTES',
  'ENC_KEYS',
  'ENC_ACTIVE_VERSION',
  'KMS_KEY_ID',
  'RL_GLOBAL_PER_MIN',
  'RL_AUTH_PER_MIN',
  'RL_BOOKING_PER_MIN',
  'SLOT_HOLD_MINUTES',
  'MIN_BOOKING_LEAD_MINUTES',
  'CANCEL_FULL_REFUND_HOURS',
  'IDEMPOTENCY_TTL_HOURS',
  'PAYMENT_PROVIDER',
  'PAYMENT_WEBHOOK_SECRET',
  'PAYMENT_API_KEY',
  'PAYMENT_TIMEOUT_MS',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_SERVICE_NAME',
  'METRICS_TOKEN',
] as const;

export type Env = Omit<z.infer<typeof envSchema>, 'CORS_ORIGINS'> & { CORS_ORIGINS: string[] };

export function parseEnv(input: NodeJS.ProcessEnv = process.env): Env {
  const configInput = Object.fromEntries(envKeys.map((key) => [key, input[key]]));
  const parsed = envSchema.safeParse(configInput);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const corsOrigins = parsed.data.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (parsed.data.NODE_ENV !== 'production') {
    const loopbackAliases = corsOrigins.flatMap((origin) => {
      try {
        const url = new URL(origin);
        if (url.hostname === 'localhost') {
          url.hostname = '127.0.0.1';
          return [url.origin];
        }
        if (url.hostname === '127.0.0.1') {
          url.hostname = 'localhost';
          return [url.origin];
        }
      } catch {
        return [];
      }
      return [];
    });
    corsOrigins.push(...loopbackAliases);
  }

  return {
    ...parsed.data,
    CORS_ORIGINS: [...new Set(corsOrigins)],
  };
}

function loadEnv(): Env {
  try {
    return parseEnv();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid environment configuration';
    console.error(message);
    process.exitCode = 1;
    throw error;
  }
}

export const env = loadEnv();
