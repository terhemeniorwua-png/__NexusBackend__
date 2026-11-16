import { z } from 'zod';

/**
 * Validation schemas for the team endpoints.
 *
 * Unknown keys are rejected, so a client cannot set fields it is not allowed
 * to change, such as the workspace the team belongs to or its archived state.
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

// ---------------------------------------------------------------------------
// Parameter schemas
// ---------------------------------------------------------------------------

export const workspaceIdParamsSchema = z.object({
  workspaceId: z.string().trim().uuid('The workspace id is not valid'),
});

export const teamParamsSchema = z.object({
  workspaceId: z.string().trim().uuid('The workspace id is not valid'),
  teamId: z.string().trim().uuid('The team id is not valid'),
});

export const teamMemberParamsSchema = z.object({
  workspaceId: z.string().trim().uuid('The workspace id is not valid'),
  teamId: z.string().trim().uuid('The team id is not valid'),
  userId: z.string().trim().uuid('The user id is not valid'),
});

export const teamInvitationParamsSchema = z.object({
  workspaceId: z.string().trim().uuid('The workspace id is not valid'),
  teamId: z.string().trim().uuid('The team id is not valid'),
  invitationId: z.string().trim().uuid('The invitation id is not valid'),
});

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

export const listTeamsQuerySchema = z.object({
  includeArchived: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

export const listTeamInvitationsQuerySchema = z.object({
  status: z.enum(['PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED', 'ALL']).default('ALL'),
});

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

export const createTeamSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.optional(),
    departmentId: z.string().trim().uuid('The department id is not valid').optional().nullable(),
    leadId: z.string().trim().uuid('The lead user id is not valid').optional().nullable(),
  })
  .strict();

export const createTeamInvitationSchema = z.object({
  targetUserId: z.string().trim().uuid('The user id is not valid'),
}).strict();

export const updateTeamSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    departmentId: z.string().trim().uuid('The department id is not valid').nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

/**
 * The roles a caller may assign to a team member.
 *
 * `TEAM_LEAD` and `MEMBER` are both valid direct assignments.
 */
export const teamMemberRoleSchema = z.enum(['TEAM_LEAD', 'MEMBER']);

export const addTeamMemberSchema = z
  .object({
    userId: z.string().trim().uuid('The user id is not valid'),
    role: teamMemberRoleSchema.default('MEMBER'),
  })
  .strict();

export const updateTeamMemberRoleSchema = z
  .object({
    role: teamMemberRoleSchema,
  })
  .strict();

export const changeTeamLeadSchema = z
  .object({
    leadId: z.string().trim().uuid('The lead user id is not valid').nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type CreateTeamInput = z.infer<typeof createTeamSchema>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema>;
export type AddTeamMemberInput = z.infer<typeof addTeamMemberSchema>;
export type UpdateTeamMemberRoleInput = z.infer<typeof updateTeamMemberRoleSchema>;
export type ChangeTeamLeadInput = z.infer<typeof changeTeamLeadSchema>;
export type ListTeamsQuery = z.infer<typeof listTeamsQuerySchema>;
