import { z } from 'zod';

/**
 * Validation for the project endpoints.
 *
 * Unknown keys are rejected, so a client cannot set server-owned fields such
 * as the project id, its archival state or its audit history.
 */

// ---------------------------------------------------------------------------
// Shared field schemas
// ---------------------------------------------------------------------------

const nameSchema = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(120, 'Name must be at most 120 characters');

const descriptionSchema = z
  .string()
  .trim()
  .max(2000, 'Description must be at most 2000 characters')
  .nullable();

const projectKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'A project key is 2–10 uppercase letters or digits');

const dateSchema = z
  .string()
  .trim()
  .min(1, 'Enter a date')
  .transform((value, ctx) => {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: 'custom', message: 'Enter a valid ISO 8601 date' });
      return z.NEVER;
    }

    return date;
  });

const nullableDateSchema = z.union([dateSchema, z.null()]);

const labelSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    color: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Use a six-digit hex colour such as #4f46e5')
      .optional(),
  })
  .strict();

const customFieldSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    type: z.enum(['text', 'number', 'date', 'select', 'checkbox']),
    options: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  })
  .strict();

/**
 * Project settings hold lightweight per-project configuration.
 *
 * Labels and custom fields are declared here rather than as separate tables
 * because they are project metadata. Task records that reference them belong
 * to the task phase.
 */
export const projectSettingsSchema = z
  .object({
    labels: z.array(labelSchema).max(100).optional(),
    customFields: z.array(customFieldSchema).max(100).optional(),
  })
  .strict();

export const projectRoleSchema = z.enum(['PROJECT_MANAGER', 'MEMBER', 'VIEWER']);

export const projectStatusSchema = z.enum([
  'PLANNING',
  'ACTIVE',
  'ON_HOLD',
  'COMPLETED',
  'ARCHIVED',
]);

const updateProjectStatusSchema = z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED']);

export const projectVisibilitySchema = z.enum(['PRIVATE', 'WORKSPACE']);

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

export const workspaceIdParamsSchema = z.object({
  workspaceId: z.string().trim().uuid('The workspace id is not valid'),
});

export const projectParamsSchema = z.object({
  workspaceId: z.string().trim().uuid('The workspace id is not valid'),
  projectId: z.string().trim().uuid('The project id is not valid'),
});

export const projectMemberParamsSchema = z.object({
  workspaceId: z.string().trim().uuid('The workspace id is not valid'),
  projectId: z.string().trim().uuid('The project id is not valid'),
  userId: z.string().trim().uuid('The user id is not valid'),
});

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

const booleanString = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

export const listProjectsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: projectStatusSchema.optional(),
  visibility: projectVisibilitySchema.optional(),
  teamId: z.string().trim().uuid('The team id is not valid').optional(),
  ownerId: z.string().trim().uuid('The owner id is not valid').optional(),
  search: z.string().trim().min(1).max(120).optional(),
  includeArchived: booleanString,
  sortBy: z
    .enum(['name', 'status', 'startDate', 'dueDate', 'createdAt', 'updatedAt'])
    .default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export const projectActivityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

export const createProjectSchema = z
  .object({
    name: nameSchema,
    key: projectKeySchema.optional(),
    description: descriptionSchema.optional(),
    status: z.enum(['PLANNING', 'ACTIVE']).default('PLANNING'),
    visibility: projectVisibilitySchema.default('WORKSPACE'),
    teamId: z.string().trim().uuid('The team id is not valid').optional().nullable(),
    ownerId: z.string().trim().uuid('The owner id is not valid').optional(),
    startDate: nullableDateSchema.optional(),
    dueDate: nullableDateSchema.optional(),
    settings: z.union([projectSettingsSchema, z.null()]).optional(),
  })
  .strict()
  .refine(
    (value) =>
      !value.startDate || !value.dueDate || value.startDate.getTime() <= value.dueDate.getTime(),
    {
      path: ['dueDate'],
      message: 'The due date must not be earlier than the start date',
    },
  );

export const updateProjectSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    status: updateProjectStatusSchema.optional(),
    visibility: projectVisibilitySchema.optional(),
    teamId: z.string().trim().uuid('The team id is not valid').optional().nullable(),
    startDate: nullableDateSchema.optional(),
    dueDate: nullableDateSchema.optional(),
    settings: z.union([projectSettingsSchema, z.null()]).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const addProjectMemberSchema = z
  .object({
    userId: z.string().trim().uuid('The user id is not valid'),
    role: projectRoleSchema.default('MEMBER'),
  })
  .strict();

export const updateProjectMemberRoleSchema = z
  .object({
    role: projectRoleSchema,
  })
  .strict();

export const changeProjectOwnerSchema = z
  .object({
    userId: z.string().trim().uuid('The user id is not valid'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type AddProjectMemberInput = z.infer<typeof addProjectMemberSchema>;
export type UpdateProjectMemberRoleInput = z.infer<typeof updateProjectMemberRoleSchema>;
export type ChangeProjectOwnerInput = z.infer<typeof changeProjectOwnerSchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
export type ProjectActivityQuery = z.infer<typeof projectActivityQuerySchema>;
export type ProjectSettingsInput = z.infer<typeof projectSettingsSchema>;
