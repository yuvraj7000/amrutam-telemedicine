import { z } from 'zod';

const mode = z.enum(['VIDEO', 'AUDIO', 'CHAT']);
const textList = z.array(z.string().trim().min(1).max(80)).max(20);

export const doctorProfileSchema = z
  .object({
    specializations: textList,
    languages: textList,
    bio: z.string().trim().max(5000).optional(),
    yearsExperience: z.number().int().min(0).max(70),
    consultationFeeMinor: z.number().int().min(0).max(10_000_000),
    modes: z.array(mode).min(1).max(3),
    isAccepting: z.boolean(),
  })
  .strict();

export const doctorSearchSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    specialization: z.union([z.string().max(80), z.array(z.string().max(80))]).optional(),
    language: z.union([z.string().max(30), z.array(z.string().max(30))]).optional(),
    mode: mode.optional(),
    minFee: z.coerce.number().int().min(0).optional(),
    maxFee: z.coerce.number().int().min(0).optional(),
    minRating: z.coerce.number().min(0).max(5).optional(),
    availableFrom: z.string().datetime({ offset: true }).optional(),
    availableTo: z.string().datetime({ offset: true }).optional(),
    sort: z
      .enum(['rating', 'fee_asc', 'fee_desc', 'experience', 'next_available'])
      .default('rating'),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
    includeUnverified: z
      .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
      .default(false),
  })
  .strict()
  .refine(
    (value) =>
      value.minFee === undefined || value.maxFee === undefined || value.minFee <= value.maxFee,
    {
      path: ['maxFee'],
      message: 'maxFee must be greater than or equal to minFee',
    },
  )
  .refine((value) => (value.availableFrom === undefined) === (value.availableTo === undefined), {
    path: ['availableTo'],
    message: 'availableFrom and availableTo must be supplied together',
  })
  .refine(
    (value) =>
      !value.availableFrom ||
      !value.availableTo ||
      new Date(value.availableFrom) < new Date(value.availableTo),
    {
      path: ['availableTo'],
      message: 'availableTo must be after availableFrom',
    },
  );

export const doctorIdSchema = z.object({ id: z.string().uuid() }).strict();
export const verificationSchema = z
  .object({
    status: z.enum(['VERIFIED', 'REJECTED']),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();
export type DoctorProfileInput = z.infer<typeof doctorProfileSchema>;
export type DoctorSearchInput = z.infer<typeof doctorSearchSchema>;
