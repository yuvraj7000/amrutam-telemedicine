import { z } from 'zod';

const slot = z
  .object({
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, context) => {
    const duration = new Date(value.end).getTime() - new Date(value.start).getTime();
    if (duration <= 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end'],
        message: 'Slot end must be after its start.',
      });
    } else if (duration > 4 * 60 * 60 * 1000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end'],
        message: 'A slot cannot be longer than 4 hours.',
      });
    }
  });
const recurrence = z
  .object({
    from: z.string().date(),
    to: z.string().date(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    dailyWindows: z
      .array(
        z
          .object({
            start: z.string().regex(/^\d{2}:\d{2}$/),
            end: z.string().regex(/^\d{2}:\d{2}$/),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    slotMinutes: z.number().int().min(5).max(240),
    timezone: z.string().min(1).max(100),
  })
  .strict();

export const createSlotsSchema = z.union([
  z.object({ slots: z.array(slot).min(1).max(200) }).strict(),
  z.object({ recurrence }).strict(),
]);
export const slotQuerySchema = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    status: z.enum(['AVAILABLE', 'HELD', 'BOOKED', 'CANCELLED']).optional(),
  })
  .strict()
  .refine((value) => new Date(value.from) < new Date(value.to), {
    path: ['to'],
    message: 'to must be after from',
  });
export const availabilityQuerySchema = z
  .object({
    from: z.string().date(),
    to: z.string().date(),
  })
  .strict()
  .refine((value) => value.from <= value.to, { path: ['to'], message: 'to must not precede from' });
export const slotIdSchema = z.object({ id: z.string().uuid() }).strict();
export const doctorIdSchema = z.object({ doctorId: z.string().uuid() }).strict();
export type CreateSlotsInput = z.infer<typeof createSlotsSchema>;
