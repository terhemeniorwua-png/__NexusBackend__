import { z } from 'zod';

const uuid = z.string().uuid();
const dateInput = z.string().datetime({ offset: true }).optional().nullable();

const expectedDeliverablesSchema = z
  .array(
    z
      .object({
        id: z.string().trim().min(1).max(120).optional(),
        label: z.string().trim().min(1).max(300),
        required: z.boolean().optional().default(true),
      })
      .strict(),
  )
  .max(50);

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export const taskParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
});

export const taskWorkspaceProjectParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
});

export const subtaskParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
  subtaskId: uuid,
});

// ---------------------------------------------------------------------------
// Create task
// ---------------------------------------------------------------------------

export const createTaskSchema = z
  .object({
    title: z.string().trim().min(2).max(200),
    description: z.string().trim().max(10000).optional(),
    status: z
      .enum([
        'ASSIGNED',
        'IN_PROGRESS',
        'SUBMITTED',
        'UNDER_REVIEW',
        'APPROVED',
        'CHANGES_REQUESTED',
      ])
      .optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
    category: z.string().trim().max(80).optional(),
    labels: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    startDate: dateInput,
    dueDate: dateInput,
    position: z.number().int().min(0).optional(),
    parentTaskId: uuid.optional().nullable(),
    weight: z.number().int().positive().optional(),
    assigneeIds: z.array(uuid).max(50).optional(),
    requiresApproval: z.boolean().optional(),
    expectedDeliverables: expectedDeliverablesSchema.optional().nullable(),
  })
  .strict()
  .refine(
    (value) =>
      !value.startDate || !value.dueDate || new Date(value.startDate) <= new Date(value.dueDate),
    {
      message: 'Start date must be on or before the due date',
      path: ['dueDate'],
    },
  );

export type CreateTaskInput = z.infer<typeof createTaskSchema>;

// ---------------------------------------------------------------------------
// Update task
// ---------------------------------------------------------------------------

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(10000).optional(),
    status: z
      .enum([
        'ASSIGNED',
        'IN_PROGRESS',
        'SUBMITTED',
        'UNDER_REVIEW',
        'APPROVED',
        'CHANGES_REQUESTED',
      ])
      .optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
    category: z.string().trim().max(80).optional().nullable(),
    labels: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    startDate: dateInput,
    dueDate: dateInput,
    position: z.number().int().min(0).optional(),
    parentTaskId: uuid.optional().nullable(),
    weight: z.number().int().positive().optional(),
    requiresApproval: z.boolean().optional(),
    expectedDeliverables: expectedDeliverablesSchema.optional().nullable(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update')
  .refine(
    (value) =>
      !value.startDate || !value.dueDate || new Date(value.startDate) <= new Date(value.dueDate),
    {
      message: 'Start date must be on or before the due date',
      path: ['dueDate'],
    },
  );

export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const taskWorkspaceQuerySchema = z.object({});

export const taskActivityQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const submitTaskSchema = z
  .object({
    workSummary: z.string().trim().min(1).max(10000),
  })
  .strict();

export type SubmitTaskInput = z.infer<typeof submitTaskSchema>;

export const reviewTaskSchema = z
  .object({
    decision: z.enum(['START_REVIEW', 'APPROVE', 'REQUEST_CHANGES']),
    feedback: z.string().trim().max(10000).optional().nullable(),
  })
  .strict()
  .refine(
    (value) => value.decision !== 'REQUEST_CHANGES' || Boolean(value.feedback?.trim()),
    {
      message: 'Feedback is required when requesting changes',
      path: ['feedback'],
    },
  );

export type ReviewTaskInput = z.infer<typeof reviewTaskSchema>;

export const completeSubtaskSchema = z
  .object({
    workSummary: z.string().trim().max(10000).optional(),
  })
  .strict();

export type CompleteSubtaskInput = z.infer<typeof completeSubtaskSchema>;

// ---------------------------------------------------------------------------
// List tasks query
// ---------------------------------------------------------------------------

export const listTasksQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z
    .enum([
      'ASSIGNED',
      'IN_PROGRESS',
      'SUBMITTED',
      'UNDER_REVIEW',
      'APPROVED',
      'CHANGES_REQUESTED',
    ])
    .optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  assigneeId: uuid.optional(),
  labels: z
    .union([z.array(z.string().trim().min(1).max(40)), z.string().transform((value) => [value])])
    .optional(),
  search: z.string().trim().min(1).max(100).optional(),
  sortBy: z
    .enum(['position', 'dueDate', 'priority', 'createdAt'])
    .optional()
    .default('position'),
  sortOrder: z.enum(['asc', 'desc']).optional().default('asc'),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export type ListTasksQuery = z.infer<typeof listTasksQuerySchema>;

// ---------------------------------------------------------------------------
// Assignee management
// ---------------------------------------------------------------------------

export const assigneeParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
  userId: uuid,
});

export const addAssigneeSchema = z
  .object({
    targetUserId: uuid,
  })
  .strict();

export type AddAssigneeInput = z.infer<typeof addAssigneeSchema>;

// ---------------------------------------------------------------------------
// Dependency management
// ---------------------------------------------------------------------------

export const dependencyParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
  dependsOnTaskId: uuid,
});

export const addDependencySchema = z
  .object({
    dependsOnTaskId: uuid,
  })
  .strict();

export type AddDependencyInput = z.infer<typeof addDependencySchema>;

// ---------------------------------------------------------------------------
// Comment management
// ---------------------------------------------------------------------------

export const commentParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
  commentId: uuid,
});

export const createCommentSchema = z
  .object({
    body: z.string().trim().min(1).max(10000),
    parentId: uuid.optional().nullable(),
    mentionedUserIds: z.array(uuid).max(50).optional().default([]).refine(
      (ids) => new Set(ids).size === ids.length,
      'Mentioned users must be unique',
    ),
  })
  .strict();

export type CreateCommentInput = z.infer<typeof createCommentSchema>;

export const updateCommentSchema = z
  .object({
    body: z.string().trim().min(1).max(10000),
  })
  .strict();

export type UpdateCommentInput = z.infer<typeof updateCommentSchema>;

export const listCommentsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type ListTaskActivityQuery = z.infer<typeof taskActivityQuerySchema>;
