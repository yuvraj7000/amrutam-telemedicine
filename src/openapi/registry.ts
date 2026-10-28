import { extendZodWithOpenApi, OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

export const idempotencyKeyHeaders = z.object({
  'Idempotency-Key': z.string().min(8).max(128),
});
