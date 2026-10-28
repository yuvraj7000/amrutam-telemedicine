import { z } from 'zod';

export const bookConsultationSchema = z
  .object({
    slotId: z.string().uuid(),
    mode: z.enum(['VIDEO', 'AUDIO', 'CHAT']),
    reason: z.string().trim().min(1).max(5000).optional(),
  })
  .strict();
export const listConsultationsSchema = z
  .object({
    status: z
      .enum([
        'PENDING_PAYMENT',
        'CONFIRMED',
        'IN_PROGRESS',
        'COMPLETED',
        'CANCELLED',
        'EXPIRED',
        'NO_SHOW',
      ])
      .optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
  })
  .strict();
export const consultationIdSchema = z.object({ id: z.string().uuid() }).strict();
export const cancelConsultationSchema = z
  .object({ reason: z.string().trim().min(1).max(1000) })
  .strict();
export const completeConsultationSchema = z
  .object({ notes: z.string().trim().min(1).max(5000) })
  .strict();
export type BookConsultationInput = z.infer<typeof bookConsultationSchema>;
