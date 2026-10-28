import { z } from 'zod';
const password = z.string().min(12).max(256);
const doctor = z.object({
  licenseNumber: z.string().min(1).max(100), specializations: z.array(z.string().min(1).max(80)).min(1).max(20),
  languages: z.array(z.string().min(2).max(10)).min(1).max(10), consultationFeeMinor: z.number().int().nonnegative(),
  yearsExperience: z.number().int().min(0).max(70), bio: z.string().max(5000).optional(),
}).strict();
export const registerSchema = z.object({
  email: z.string().email().max(320), password, fullName: z.string().min(1).max(200), phone: z.string().max(30).optional(),
  role: z.enum(['PATIENT', 'DOCTOR']).default('PATIENT'), doctor: doctor.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.role === 'DOCTOR' && !value.doctor) ctx.addIssue({ code: 'custom', path: ['doctor'], message: 'Doctor details are required' });
  if (value.role === 'PATIENT' && value.doctor) ctx.addIssue({ code: 'custom', path: ['doctor'], message: 'Doctor details are not allowed' });
});
export const loginSchema = z.object({ email: z.string().email(), password: z.string().max(256) }).strict();
export const refreshSchema = z.object({ refreshToken: z.string().min(1) }).strict();
export const changePasswordSchema = z.object({ currentPassword: z.string(), newPassword: password }).strict();
export const verifyMfaSchema = z.object({
  mfaToken: z.string().min(1),
  code: z.string().regex(/^\d{6}$/).optional(),
  backupCode: z.string().min(1).max(64).optional(),
}).strict().refine((value) => Boolean(value.code) !== Boolean(value.backupCode), {
  message: 'Provide either a TOTP code or a backup code.',
});
export const enableMfaSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const disableMfaSchema = z.object({ password: z.string().min(1).max(256), code: z.string().regex(/^\d{6}$/) }).strict();
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;