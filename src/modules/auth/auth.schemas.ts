import { z } from 'zod';
import { PASSWORD_MAX_BYTES, PASSWORD_MAX_LENGTH } from '../../services/password';

/**
 * Request validation for the authentication endpoints.
 *
 * Every schema rejects unknown keys so that a client cannot smuggle extra
 * fields (for example a role or a workspace id) into a payload.
 */

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email address is too long')
  .email('Enter a valid email address');

const nameSchema = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(100, 'Name must be at most 100 characters');

/**
 * Passwords that are trivially guessable. This is intentionally a small,
 * explicit list rather than a large embedded corpus.
 */
const commonPasswords = new Set([
  'password',
  'password1',
  'password123',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  'qwertyuiop',
  'qwerty123',
  'letmein1',
  'welcome1',
  'welcome123',
  'admin123',
  'administrator',
  'iloveyou',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'trustno1',
  'dragon123',
  'monkey123',
  'nexus123',
  'nexus2024',
]);

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`)
  .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), {
    message: 'Password must contain at least one letter and one number',
  })
  .refine((value) => !commonPasswords.has(value.toLowerCase()), {
    message: 'This password is too common. Please choose a different one',
  })
  .refine((value) => Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES, {
    message: `Password must not exceed ${PASSWORD_MAX_BYTES} bytes`,
  });

export const registerSchema = z
  .object({
    email: emailSchema,
    name: nameSchema,
    password: passwordSchema,
  })
  .strict();

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, 'Password is required').max(PASSWORD_MAX_LENGTH),
  })
  .strict();

const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter a six-digit authentication code');
const recoveryCodeSchema = z.string().trim().min(8).max(32);

export const twoFactorChallengeSchema = z
  .object({
    challengeToken: z.string().trim().min(20).max(1024),
    code: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.code) !== Boolean(value.recoveryCode), {
    message: 'Provide either a TOTP code or a recovery code',
    path: ['code'],
  });
export const twoFactorConfirmSchema = z.object({ code: totpCodeSchema }).strict();
export const twoFactorDisableSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    code: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.code) !== Boolean(value.recoveryCode), {
    message: 'Provide either a TOTP code or a recovery code',
    path: ['code'],
  });
export const recoveryCodeRegenerateSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH).optional(),
    code: totpCodeSchema.optional(),
    recoveryCode: recoveryCodeSchema.optional(),
  })
  .strict()
  .refine(
    (value) => {
      const password = Boolean(value.currentPassword);
      const proof = Boolean(value.code) !== Boolean(value.recoveryCode);
      return password !== proof && !(value.code && value.recoveryCode);
    },
    {
      message: 'Provide either your current password or one verification code',
      path: ['currentPassword'],
    },
  );

export const verifyEmailSchema = z
  .object({
    token: z.string().trim().min(20, 'The verification token is invalid').max(512),
  })
  .strict();

export const emailOnlySchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const passwordResetRequestSchema = z
  .object({
    email: emailSchema,
  })
  .strict();

export const passwordResetSchema = z
  .object({
    token: z.string().trim().min(20, 'The reset token is invalid').max(512),
    password: passwordSchema,
  })
  .strict();

export const passwordChangeSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, 'Your current password is required')
      .max(PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema,
  })
  .strict();

export const emailChangeSchema = z
  .object({
    email: emailSchema,
    currentPassword: z
      .string()
      .min(1, 'Your current password is required')
      .max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export const confirmEmailChangeSchema = z
  .object({
    token: z.string().trim().min(20, 'The verification token is invalid').max(512),
  })
  .strict();

export const accountActionSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, 'Your current password is required')
      .max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export const accountDeleteSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, 'Your current password is required')
      .max(PASSWORD_MAX_LENGTH),
    confirmation: z.string().trim().min(1, 'Type your email address to confirm'),
  })
  .strict();

export const refreshSchema = z
  .object({
    refreshToken: z.string().trim().min(20).max(512).optional(),
  })
  .strict();

export const googleExchangeSchema = z.object({ code: z.string().trim().min(32).max(256) }).strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type PasswordResetInput = z.infer<typeof passwordResetSchema>;
export type PasswordChangeInput = z.infer<typeof passwordChangeSchema>;
export type EmailChangeInput = z.infer<typeof emailChangeSchema>;
export type AccountDeleteInput = z.infer<typeof accountDeleteSchema>;
