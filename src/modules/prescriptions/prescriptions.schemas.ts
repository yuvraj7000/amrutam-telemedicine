import { z } from 'zod';

const medicationSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    dosage: z.string().trim().min(1).max(100),
    frequency: z.string().trim().min(1).max(100),
    durationDays: z.number().int().min(1).max(365),
    instructions: z.string().trim().max(1000).optional(),
  })
  .strict();

export const prescriptionInputSchema = z
  .object({
    diagnosis: z.string().trim().min(1).max(2000),
    medications: z.array(medicationSchema).min(1).max(50),
    advice: z.string().trim().max(5000).optional(),
    followUpDate: z.string().date().optional(),
    validUntil: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export const prescriptionIdSchema = z.object({ id: z.string().uuid() }).strict();
export const consultationIdSchema = z.object({ consultationId: z.string().uuid() }).strict();
export type PrescriptionInput = z.infer<typeof prescriptionInputSchema>;
