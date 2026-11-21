import { z } from 'zod';

const uuid = z.string().uuid();

export const reviewProjectParamsSchema = z.object({ workspaceId: uuid, projectId: uuid });
export const reviewParamsSchema = reviewProjectParamsSchema.extend({ reviewId: uuid });

export const reviewStatusSchema = z.enum([
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'CHANGES_REQUESTED',
]);

export const targetKindSchema = z.enum(['attachmentVersion', 'checklist']);

export const listReviewsQuerySchema = z.object({
  targetKind: targetKindSchema.optional(),
  targetId: uuid.optional(),
  status: reviewStatusSchema.optional(),
  assigneeId: uuid.optional(),
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const createReviewSchema = z
  .object({
    attachmentVersionId: uuid.optional(),
    checklistId: uuid.optional(),
    assigneeId: uuid.optional(),
  })
  .refine((value) => Boolean(value.attachmentVersionId) !== Boolean(value.checklistId), {
    message: 'Exactly one review target must be provided',
  });

export const assignReviewSchema = z.object({ assigneeId: uuid });

export const resubmitReviewSchema = z.object({
  round: z.number().int().positive(),
});

export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;
export type CreateReviewInput = z.infer<typeof createReviewSchema>;
export type AssignReviewInput = z.infer<typeof assignReviewSchema>;
export type ResubmitReviewInput = z.infer<typeof resubmitReviewSchema>;
