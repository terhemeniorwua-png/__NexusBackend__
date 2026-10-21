import { z } from 'zod';

/**
 * Validation for the profile endpoints.
 *
 * Unknown keys are rejected so that a client cannot update fields it is not
 * allowed to change, such as the account status or the email address (that
 * has its own verified flow).
 */

const nameSchema = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(100, 'Name must be at most 100 characters');

const nullableText = (max: number, label: string) =>
  z.string().trim().max(max, `${label} must be at most ${max} characters`).nullable();

const avatarUrlSchema = z
  .string()
  .trim()
  .max(2048, 'Avatar URL is too long')
  .url('Enter a valid avatar URL')
  .refine((value) => value.startsWith('https://') || value.startsWith('http://'), {
    message: 'Avatar URL must use http or https',
  })
  .nullable();

export const updateProfileSchema = z
  .object({
    name: nameSchema.optional(),
    bio: nullableText(500, 'Bio').optional(),
    jobTitle: nullableText(100, 'Job title').optional(),
    avatarUrl: avatarUrlSchema.optional(),
    timeZone: z.string().trim().min(1, 'Time zone is required').max(64).optional(),
    locale: z.string().trim().min(2, 'Locale is required').max(10).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
