import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const openApiEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://openapi:openapi@127.0.0.1:5432/openapi',
  REDIS_URL: 'redis://127.0.0.1:6379',
  JWT_KEYS: '{"openapi":"0123456789abcdef0123456789abcdef"}',
  JWT_ACTIVE_KID: 'openapi',
  ENC_KEYS: `{"1":"${Buffer.alloc(32, 1).toString('base64')}"}`,
  PAYMENT_WEBHOOK_SECRET: 'openapi-webhook-secret',
  METRICS_TOKEN: 'openapi-metrics-token',
};

async function generateOpenApi(): Promise<void> {
  for (const [name, value] of Object.entries(openApiEnv)) {
    process.env[name] ??= value;
  }
  const { createApp } = await import('../src/app.js');
  const { buildOpenApiDocument } = await import('../src/openapi/build-document.js');
  createApp();
  const document = buildOpenApiDocument();
  await writeFile(
    resolve(process.cwd(), 'docs/openapi.yaml'),
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

generateOpenApi().catch((error: unknown) => {
  console.error('OpenAPI generation failed', error);
  process.exitCode = 1;
});
