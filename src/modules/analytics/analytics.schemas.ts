import { z } from 'zod';

const range = {
  from: z.string().date(),
  to: z.string().date(),
};

export const overviewQuerySchema = z.object(range).strict();
export const timeseriesQuerySchema = z
  .object({
    ...range,
    metric: z.enum(['consultations', 'revenue', 'cancellations']),
    granularity: z.enum(['day', 'week']).default('day'),
  })
  .strict();
export const topDoctorsQuerySchema = z
  .object({
    ...range,
    by: z.enum(['consultations', 'revenue', 'rating']),
    limit: z.coerce.number().int().min(1).max(50).default(10),
  })
  .strict();

export type AnalyticsRangeInput = z.infer<typeof overviewQuerySchema>;
