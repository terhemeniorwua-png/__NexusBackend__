import { z } from 'zod';

/**
 * Validation for the workspace endpoints.
 *
 * Unknown keys are rejected, so a client cannot set fields it is not allowed
 * to change, such as the owner of a workspace or the status of a membership.
 */

const nameSchema = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(80, 'Name must be at most 80 characters');

const descriptionSchema = z
  .string()
  .trim()
  .max(500, 'Description must be at most 500 characters')
  .nullable();

const slugSchema = z
  .string()
  .trim()
  .min(2, 'Slug must be at least 2 characters')
  .max(50, 'Slug must be at most 50 characters')
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'Slug may only contain lowercase letters, digits and dashes',
  );

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address')
  .max(254, 'Email address is too long');

/**
 * The roles a caller may hand out.
 *
 * `OWNER` is not part of it: a workspace has exactly one owner, the account
 * that created it, and that role cannot be transferred.
 */
export const assignableRoleSchema = z.enum(['PROJECT_MANAGER', 'MEMBER', 'COLLABORATOR', 'VIEWER']);

export const workspaceRoleSchema = z.enum([
  'OWNER',
  'PROJECT_MANAGER',
  'MEMBER',
  'COLLABORATOR',
  'VIEWER',
]);

export const organizationRoleSchema = z.enum([
  'COMPANY_OWNER',
  'COMPANY_ADMIN',
  'COMPANY_PROJECT_MANAGER',
  'COMPANY_MEMBER',
  'COMPANY_COLLABORATOR',
  'COMPANY_VIEWER',
  'INSTITUTION_OWNER',
  'INSTITUTION_ADMIN',
  'INSTITUTION_DEPARTMENT_HEAD',
  'INSTITUTION_LECTURER_STAFF',
  'INSTITUTION_STUDENT',
  'INSTITUTION_COLLABORATOR',
  'INSTITUTION_VIEWER',
]);

export const workspaceIdParamsSchema = z.object({
  workspaceId: z.string().trim().uuid('The workspace id is not valid'),
});

export const memberParamsSchema = z.object({
  workspaceId: z.string().trim().uuid('The workspace id is not valid'),
  userId: z.string().trim().uuid('The user id is not valid'),
});

export const invitationParamsSchema = z.object({
  workspaceId: z.string().trim().uuid('The workspace id is not valid'),
  invitationId: z.string().trim().uuid('The invitation id is not valid'),
});

export const departmentParamsSchema = z.object({
  workspaceId: z.string().trim().uuid('The workspace id is not valid'),
  departmentId: z.string().trim().uuid('The department id is not valid'),
});

export const departmentMemberParamsSchema = departmentParamsSchema.extend({
  targetUserId: z.string().trim().uuid('The user id is not valid'),
});

export const createDepartmentSchema = z.object({ name: nameSchema }).strict();
export const updateDepartmentSchema = z.object({ name: nameSchema }).strict();

export const departmentMemberSchema = z
  .object({
    targetUserId: z.string().trim().uuid('The user id is not valid'),
    role: z.enum(['HEAD', 'MEMBER']).default('MEMBER'),
  })
  .strict();

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
export type DepartmentMemberInput = z.infer<typeof departmentMemberSchema>;

export const invitationTokenParamsSchema = z.object({
  token: z.string().trim().min(20, 'The invitation token is not valid').max(200),
});

const workspaceTypeSchema = z.enum(['INDIVIDUAL', 'COMPANY', 'INSTITUTION']);
const workspaceVisibilitySchema = z.enum(['PRIVATE', 'PUBLIC']);

export const createWorkspaceSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.optional(),
    slug: slugSchema.optional(),
    type: workspaceTypeSchema.default('COMPANY'),
    visibility: workspaceVisibilitySchema.default('PRIVATE'),
  })
  .strict();

export const updateWorkspaceSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    visibility: workspaceVisibilitySchema.optional(),
    timeTrackingEnabled: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const addMemberSchema = z
  .object({
    email: emailSchema,
    role: assignableRoleSchema.optional(),
    organizationRole: organizationRoleSchema.optional(),
  })
  .strict()
  .refine((value) => !(value.role !== undefined && value.organizationRole !== undefined), {
    message: 'Provide either a workspace role or an organization role, not both',
  })
  .transform((value) => ({ ...value, role: value.role ?? ('MEMBER' as const) }));

export const updateMemberRoleSchema = z
  .object({
    role: assignableRoleSchema.optional(),
    organizationRole: organizationRoleSchema.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.role) !== Boolean(value.organizationRole), {
    message: 'Provide exactly one role field',
  });

export const removeWorkspaceMemberSchema = z
  .object({
    reassignTasksToUserId: z
      .string()
      .trim()
      .uuid('The replacement user id is not valid')
      .optional(),
  })
  .strict()
  .default({});

export const createInvitationSchema = z
  .object({
    email: emailSchema,
    role: assignableRoleSchema.optional(),
    organizationRole: organizationRoleSchema.optional(),
  })
  .strict()
  .refine((value) => !(value.role !== undefined && value.organizationRole !== undefined), {
    message: 'Provide either a workspace role or an organization role, not both',
  })
  .transform((value) => ({ ...value, role: value.role ?? ('MEMBER' as const) }));

export const listInvitationsQuerySchema = z.object({
  status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED', 'ALL']).default('ALL'),
});

/**
 * Transfers ownership to an existing workspace member.
 *
 * The caller must be the current owner. The new owner must already be a
 * member, so their identity is expressed as a user id (from the URL param)
 * rather than an email address.
 *
 * After the transfer the previous owner becomes a PROJECT_MANAGER unless a
 * different role is requested.  `OWNER` is not a valid post-transfer role for
 * the previous owner — the workspace may only have one owner.
 */
export const transferOwnershipSchema = z
  .object({
    newOwnerRole: assignableRoleSchema.default('PROJECT_MANAGER'),
  })
  .strict();

export const ownershipTransferParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  transferId: z.string().uuid(),
}).strict();

export const incomingOwnershipTransfersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
}).strict();

export const adminOwnerAssignmentParamsSchema = z.object({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
}).strict();

export const discoverWorkspacesQuerySchema = z.object({
  search: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createJoinRequestSchema = z
  .object({
    message: z
      .string()
      .trim()
      .max(500, 'Message must be at most 500 characters')
      .nullable()
      .optional(),
  })
  .strict();

export const joinByCodeSchema = z
  .object({
    code: z.string().trim().min(20, 'The join code is not valid').max(200),
    message: z
      .string()
      .trim()
      .max(500, 'Message must be at most 500 characters')
      .nullable()
      .optional(),
  })
  .strict();

export const listJoinRequestsQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'ALL']).default('ALL'),
});

export const approveJoinRequestSchema = z
  .object({
    role: assignableRoleSchema.optional(),
    organizationRole: organizationRoleSchema.optional(),
    teamId: z.string().trim().uuid('The team id is not valid').nullable().optional(),
  })
  .strict();

export const rejectJoinRequestSchema = z
  .object({
    note: z.string().trim().max(500, 'Note must be at most 500 characters').nullable().optional(),
  })
  .strict();

export const joinRequestParamsSchema = z.object({
  workspaceId: z.string().trim().uuid('The workspace id is not valid'),
  requestId: z.string().trim().uuid('The join request id is not valid'),
});

export const joinRequestIdParamsSchema = z.object({
  requestId: z.string().trim().uuid('The join request id is not valid'),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
export type RemoveWorkspaceMemberInput = z.infer<typeof removeWorkspaceMemberSchema>;
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type ListInvitationsQuery = z.infer<typeof listInvitationsQuerySchema>;
export type AssignableRole = z.infer<typeof assignableRoleSchema>;
export type OrganizationRoleInput = z.infer<typeof organizationRoleSchema>;
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;
export type DiscoverWorkspacesQuery = z.infer<typeof discoverWorkspacesQuerySchema>;
export type CreateJoinRequestInput = z.infer<typeof createJoinRequestSchema>;
export type JoinByCodeInput = z.infer<typeof joinByCodeSchema>;
export type ListJoinRequestsQuery = z.infer<typeof listJoinRequestsQuerySchema>;
export type ApproveJoinRequestInput = z.infer<typeof approveJoinRequestSchema>;
export type RejectJoinRequestInput = z.infer<typeof rejectJoinRequestSchema>;
