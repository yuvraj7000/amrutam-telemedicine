import { z } from 'zod';

const date = z.string().date();
const optionalUuid = z.string().uuid().optional();
export const auditQuerySchema = z
  .object({
    actorId: optionalUuid,
    action: z.string().min(1).max(120).optional(),
    resourceType: z.string().min(1).max(80).optional(),
    resourceId: z.string().min(1).max(200).optional(),
    outcome: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
    from: date,
    to: date,
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(512).optional(),
  })
  .strict();

export const auditVerifySchema = z
  .object({
    shard: z.coerce.number().int().min(0).max(15),
    from: date,
    to: date,
  })
  .strict();

export type AuditQueryInput = z.infer<typeof auditQuerySchema>;
