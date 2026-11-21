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

const decisionNote = z
  .string()
  .min(1)
  .max(2000)
  .refine((value) => value.trim().length > 0, { message: 'Decision note cannot be blank' });

const decisionRound = z.number().int().positive();

export const approveReviewSchema = z.object({
  round: decisionRound,
  note: decisionNote.optional(),
});

export const rejectReviewSchema = z.object({
  round: decisionRound,
  note: decisionNote,
});

export const requestChangesReviewSchema = z.object({
  round: decisionRound,
  note: decisionNote,
});

export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;
export type CreateReviewInput = z.infer<typeof createReviewSchema>;
export type AssignReviewInput = z.infer<typeof assignReviewSchema>;
export type ResubmitReviewInput = z.infer<typeof resubmitReviewSchema>;
export type ApproveReviewInput = z.infer<typeof approveReviewSchema>;
export type RejectReviewInput = z.infer<typeof rejectReviewSchema>;
export type RequestChangesReviewInput = z.infer<typeof requestChangesReviewSchema>;
