import { z } from 'zod';
import { ONBOARDING_STEP_ORDER } from './onboarding.config';

const onboardingStepSchema = z.enum(
  ONBOARDING_STEP_ORDER as [string, ...string[]],
);

const documentTypeSchema = z
  .string()
  .trim()
  .min(1, 'Document type is required')
  .max(64, 'Document type is too long')
  .regex(/^[a-z0-9_]+$/, 'Document type must contain only lowercase letters, numbers, and underscores');

const versionSchema = z
  .string()
  .trim()
  .min(1, 'Version is required')
  .max(64, 'Version is too long');

export const acceptLegalDocumentSchema = z
  .object({
    documentType: documentTypeSchema,
    version: versionSchema,
  })
  .strict();

export const advanceOnboardingStepSchema = z
  .object({
    step: onboardingStepSchema,
    action: z.enum(['complete', 'skip']),
  })
  .strict();

export const updateAiAccessSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const emptyBodySchema = z.object({}).strict();

export type AcceptLegalDocumentInput = z.infer<typeof acceptLegalDocumentSchema>;
export type AdvanceOnboardingStepInput = z.infer<typeof advanceOnboardingStepSchema>;
export type UpdateAiAccessInput = z.infer<typeof updateAiAccessSchema>;
