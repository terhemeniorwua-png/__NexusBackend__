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

export const targetKindSchema = z.enum(['attachmentVersion', 'checklist', 'task']);

export const listReviewsQuerySchema = z.object({
  targetKind: targetKindSchema.optional(),
  targetId: uuid.optional(),
  status: reviewStatusSchema.optional(),
  assigneeId: uuid.optional(),
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const artworkUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => !/\s/.test(value), { message: 'Artwork URL must not contain whitespace' })
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'Artwork URL must be a valid http or https URL' },
  );

const decisionItemSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, { message: 'Decision text cannot be blank' })
    .max(500, { message: 'Decision text must be at most 500 characters' }),
});

const decisionsSchema = z.array(decisionItemSchema).max(20);

export const createReviewSchema = z
  .object({
    attachmentVersionId: uuid.optional(),
    checklistId: uuid.optional(),
    taskId: uuid.optional(),
    artworkUrl: artworkUrlSchema.optional(),
    decisions: decisionsSchema.optional(),
    assigneeId: uuid.optional(),
  })
  .superRefine((value, ctx) => {
    const targets = [value.attachmentVersionId, value.checklistId, value.taskId].filter(Boolean);
    if (targets.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Exactly one review target must be provided',
        path: ['taskId'],
      });
      return;
    }

    if (value.taskId) {
      if (!value.artworkUrl) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Artwork URL is required for task reviews',
          path: ['artworkUrl'],
        });
      }
      return;
    }

    if (value.artworkUrl !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Artwork URL is only valid for task reviews',
        path: ['artworkUrl'],
      });
    }
    if (value.decisions !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Decisions are only valid for task reviews',
        path: ['decisions'],
      });
    }
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

export const updateReviewSchema = z
  .object({
    round: decisionRound,
    artworkUrl: artworkUrlSchema.optional(),
    decisions: decisionsSchema.optional(),
  })
  .refine((value) => value.artworkUrl !== undefined || value.decisions !== undefined, {
    message: 'At least one of artworkUrl or decisions must be provided',
  });

export type ListReviewsQuery = z.infer<typeof listReviewsQuerySchema>;
export type CreateReviewInput = z.infer<typeof createReviewSchema>;
export type AssignReviewInput = z.infer<typeof assignReviewSchema>;
export type ResubmitReviewInput = z.infer<typeof resubmitReviewSchema>;
export type ApproveReviewInput = z.infer<typeof approveReviewSchema>;
export type RejectReviewInput = z.infer<typeof rejectReviewSchema>;
export type RequestChangesReviewInput = z.infer<typeof requestChangesReviewSchema>;
export type UpdateReviewInput = z.infer<typeof updateReviewSchema>;
