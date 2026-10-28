import { z } from 'zod';
export const paymentIdSchema = z.object({ id: z.string().uuid() }).strict();
export const refundSchema = z
  .object({
    amountMinor: z.number().int().positive().optional(),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export const simulatePaymentSchema = z
  .object({ outcome: z.enum(['succeeded', 'failed']) })
  .strict();
