import { z } from 'zod';

const uuid = z.string().uuid();
const dateInput = z.string().datetime({ offset: true }).optional().nullable();

export const sprintWorkspaceProjectParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
});

export const sprintParamsSchema = sprintWorkspaceProjectParamsSchema.extend({
  sprintId: uuid,
});

export const sprintTaskParamsSchema = sprintParamsSchema.extend({
  taskId: uuid,
});

export const listSprintsQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['PLANNED', 'ACTIVE', 'COMPLETED', 'ARCHIVED']).optional(),
});

export type ListSprintsQuery = z.infer<typeof listSprintsQuerySchema>;

export const createSprintSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    goal: z.string().trim().max(5000).optional().nullable(),
    startDate: dateInput,
    endDate: dateInput,
  })
  .strict()
  .refine(
    (value) =>
      !value.startDate || !value.endDate || new Date(value.startDate) <= new Date(value.endDate),
    { message: 'Start date must be on or before the end date', path: ['endDate'] },
  );

export type CreateSprintInput = z.infer<typeof createSprintSchema>;

export const updateSprintSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    goal: z.string().trim().max(5000).optional().nullable(),
    startDate: dateInput,
    endDate: dateInput,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update')
  .refine(
    (value) =>
      !value.startDate || !value.endDate || new Date(value.startDate) <= new Date(value.endDate),
    { message: 'Start date must be on or before the end date', path: ['endDate'] },
  );

export type UpdateSprintInput = z.infer<typeof updateSprintSchema>;

export const emptySprintBodySchema = z.object({}).strict().optional().default({});

export const completeSprintSchema = z
  .object({
    target: z.enum(['BACKLOG', 'NEXT_SPRINT']),
    nextSprintId: uuid.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.target === 'NEXT_SPRINT' && !value.nextSprintId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'nextSprintId is required when target is NEXT_SPRINT',
        path: ['nextSprintId'],
      });
    }
    if (value.target === 'BACKLOG' && value.nextSprintId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'nextSprintId is only allowed when target is NEXT_SPRINT',
        path: ['nextSprintId'],
      });
    }
  });

export type CompleteSprintInput = z.infer<typeof completeSprintSchema>;

export const sprintTasksBodySchema = z
  .object({
    taskIds: z.array(uuid).min(1).max(200),
  })
  .strict();

export type SprintTasksBodyInput = z.infer<typeof sprintTasksBodySchema>;
