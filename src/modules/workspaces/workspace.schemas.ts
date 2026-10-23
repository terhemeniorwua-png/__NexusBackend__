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

export const invitationTokenParamsSchema = z.object({
  token: z.string().trim().min(20, 'The invitation token is not valid').max(200),
});

export const createWorkspaceSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.optional(),
    slug: slugSchema.optional(),
  })
  .strict();

export const updateWorkspaceSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export const addMemberSchema = z
  .object({
    email: emailSchema,
    role: assignableRoleSchema.default('MEMBER'),
  })
  .strict();

export const updateMemberRoleSchema = z
  .object({
    role: assignableRoleSchema,
  })
  .strict();

export const createInvitationSchema = z
  .object({
    email: emailSchema,
    role: assignableRoleSchema.default('MEMBER'),
  })
  .strict();

export const listInvitationsQuerySchema = z.object({
  status: z.enum(['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED', 'ALL']).default('ALL'),
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

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;
export type AddMemberInput = z.infer<typeof addMemberSchema>;
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
export type ListInvitationsQuery = z.infer<typeof listInvitationsQuerySchema>;
export type AssignableRole = z.infer<typeof assignableRoleSchema>;
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;
