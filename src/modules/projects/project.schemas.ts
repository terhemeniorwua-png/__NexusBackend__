import { z } from 'zod';

const uuid = z.string().uuid();
const projectKey = z
  .string()
  .trim()
  .min(2)
  .max(16)
  .regex(/^[A-Za-z0-9_-]+$/);
const dateInput = z.string().datetime({ offset: true }).optional().nullable();

export const projectParamsSchema = z.object({ workspaceId: uuid, projectId: uuid });
export const projectWorkspaceParamsSchema = z.object({ workspaceId: uuid });
export const projectMemberParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  userId: uuid,
});

export const listProjectsQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'ARCHIVED']).optional(),
  visibility: z.enum(['PRIVATE', 'DEPARTMENT_TEAM', 'WORKSPACE']).optional(),
  teamId: uuid.optional(),
  departmentId: uuid.optional(),
  search: z.string().trim().min(1).max(100).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const createProjectSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    key: projectKey,
    description: z.string().trim().max(5000).nullable().optional(),
    category: z.string().trim().min(1).max(80).nullable().optional(),
    labels: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    visibility: z.enum(['PRIVATE', 'DEPARTMENT_TEAM', 'WORKSPACE']).default('WORKSPACE'),
    teamId: uuid.optional().nullable(),
    departmentId: uuid.optional().nullable(),
    startDate: dateInput,
    dueDate: dateInput,
  })
  .strict()
  .refine(
    (value) =>
      !value.startDate || !value.dueDate || new Date(value.startDate) <= new Date(value.dueDate),
    {
      message: 'Start date must be on or before the due date',
      path: ['dueDate'],
    },
  )
  .refine(
    (value) =>
      value.visibility !== 'DEPARTMENT_TEAM' || Boolean(value.teamId || value.departmentId),
    {
      message: 'Department/team-only projects must be assigned to a team or department',
      path: ['visibility'],
    },
  );

export const updateProjectSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    key: projectKey.optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    category: z.string().trim().min(1).max(80).nullable().optional(),
    labels: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
    visibility: z.enum(['PRIVATE', 'DEPARTMENT_TEAM', 'WORKSPACE']).optional(),
    status: z.enum(['PLANNING', 'ACTIVE', 'ON_HOLD', 'COMPLETED']).optional(),
    teamId: uuid.nullable().optional(),
    departmentId: uuid.nullable().optional(),
    startDate: dateInput,
    dueDate: dateInput,
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');

export const projectMemberSchema = z
  .object({
    userId: uuid,
    role: z.enum(['PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER']).default('MEMBER'),
  })
  .strict();

export const updateProjectMemberSchema = z
  .object({
    role: z.enum(['PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER']),
  })
  .strict();

export const projectRoleEnum = z.enum([
  'PROJECT_MANAGER',
  'MEMBER',
  'COLLABORATOR',
  'VIEWER',
]);

export const projectPermissionsResponseSchema = z.object({
  projectId: uuid,
  workspaceRole: z.string(),
  projectRole: projectRoleEnum.nullable(),
  accessSource: z.enum([
    'workspace_admin',
    'project_member',
    'workspace_member',
    'team_member',
    'department_member',
  ]),
  permissions: z.array(z.string()),
  assignableRoles: z.array(projectRoleEnum),
});

export const projectActivityQuerySchema = z.object({
  cursor: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const projectMilestoneParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  milestoneId: uuid,
});
export const transferProjectOwnershipSchema = z
  .object({
    newOwnerId: uuid,
    previousOwnerRole: z.enum(['MANAGER', 'MEMBER', 'REMOVE']).default('MANAGER'),
  })
  .strict();
export const createProjectMilestoneSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(2000).nullable().optional(),
    dueDate: dateInput,
    position: z.number().int().min(0).optional(),
  })
  .strict();
export const updateProjectMilestoneSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    dueDate: dateInput,
    completed: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Provide at least one field to update');

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;
export type TransferProjectOwnershipInput = z.infer<typeof transferProjectOwnershipSchema>;
export type ProjectPermissionsResponse = z.infer<typeof projectPermissionsResponseSchema>;
