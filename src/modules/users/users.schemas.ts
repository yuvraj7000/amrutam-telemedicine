import { z } from 'zod';
export const updateUserSchema = z.object({ phone: z.string().max(30).optional() }).strict();
export const profileSchema = z.object({
  fullName: z.string().min(1).max(200), gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED']).optional(),
  dateOfBirth: z.string().date().optional(), address: z.string().max(2000).optional(),
  emergencyContact: z.string().max(500).optional(), locale: z.string().max(20).optional(), timezone: z.string().max(80).optional(),
}).strict();
export type ProfileInput = z.infer<typeof profileSchema>;