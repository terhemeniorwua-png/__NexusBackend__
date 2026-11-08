import { z } from 'zod';

const uuidSchema = z.string().trim().uuid();

export const privacyRequestParamsSchema = z.object({ requestId: uuidSchema }).strict();
export const privacyRequestTargetParamsSchema = z
  .object({
    requestId: uuidSchema,
    targetId: uuidSchema,
  })
  .strict();

export const createPrivacyRequestSchema = z
  .object({
    type: z.enum(['ACCESS', 'CORRECTION', 'ERASURE', 'REDACTION']),
    description: z.string().trim().min(1).max(2_000).optional(),
    targetType: z.literal('COMMENT').optional(),
    targetId: uuidSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.type === 'REDACTION' && (!value.targetType || !value.targetId)) {
      context.addIssue({
        code: 'custom',
        message: 'Redaction requests must identify a comment target',
      });
    }
    if (value.type !== 'REDACTION' && (value.targetType || value.targetId)) {
      context.addIssue({
        code: 'custom',
        message: 'Only redaction requests may identify a target',
      });
    }
  });

export const privacyRequestListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: uuidSchema.optional(),
    status: z.enum(['SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED']).optional(),
  })
  .strict();

export const privacyDecisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: z.string().trim().max(2_000).optional(),
  })
  .strict();

export const privacyCompletionSchema = z
  .object({
    outcome: z.string().trim().min(1).max(4_000),
  })
  .strict();

export const privacyRedactionSchema = z
  .object({
    matchText: z.string().min(1).max(4_000),
    replacementText: z.string().max(4_000),
  })
  .strict();
