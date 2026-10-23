import type { PrismaClient, Team, TeamMembership, TeamRole, WorkspaceRole } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * Team-level authorization policy.
 *
 * A team lives inside a workspace. Access is governed by the caller's
 * workspace role and their explicit team membership (if any). The rules are:
 *
 * - The workspace OWNER and PROJECT_MANAGER can read and manage every team
 *   in the workspace regardless of whether they hold a team membership row.
 * - A workspace MEMBER, COLLABORATOR or VIEWER must have an explicit
 *   `TeamMembership` row to access team-specific operations.
 * - Team management (update, archive, delete, manage members) requires
 *   either the workspace OWNER / PROJECT_MANAGER role, or the team-level
 *   TEAM_LEAD role.
 *
 * Phase 6 establishes the policy. The actual team endpoints are implemented
 * in Phase 7. These guards are available early so they can be used in other
 * modules that need to reason about team access (e.g. project visibility).
 */

// ---------------------------------------------------------------------------
// Capability constants
// ---------------------------------------------------------------------------

export const TeamCapability = {
  ViewTeam: 'team:view',
  UpdateTeam: 'team:update',
  ArchiveTeam: 'team:archive',
  DeleteTeam: 'team:delete',
  ManageMembers: 'team:manage_members',
  ViewMembers: 'team:view_members',
} as const;

export type TeamCapabilityValue = (typeof TeamCapability)[keyof typeof TeamCapability];

// ---------------------------------------------------------------------------
// Role → capability matrices
// ---------------------------------------------------------------------------

/**
 * What a workspace-level role can do inside any team.
 */
const WORKSPACE_ROLE_TEAM_CAPABILITIES: Record<WorkspaceRole, readonly TeamCapabilityValue[]> = {
  OWNER: [
    'team:view',
    'team:update',
    'team:archive',
    'team:delete',
    'team:manage_members',
    'team:view_members',
  ],
  PROJECT_MANAGER: [
    'team:view',
    'team:update',
    'team:archive',
    'team:delete',
    'team:manage_members',
    'team:view_members',
  ],
  MEMBER: ['team:view', 'team:view_members'],
  COLLABORATOR: [],
  VIEWER: [],
};

/**
 * What an explicit team-level role can do.
 */
const TEAM_ROLE_CAPABILITIES: Record<TeamRole, readonly TeamCapabilityValue[]> = {
  TEAM_LEAD: ['team:view', 'team:update', 'team:manage_members', 'team:view_members'],
  MEMBER: ['team:view', 'team:view_members'],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function workspaceRoleCanOnTeam(
  workspaceRole: WorkspaceRole,
  capability: TeamCapabilityValue,
): boolean {
  return WORKSPACE_ROLE_TEAM_CAPABILITIES[workspaceRole].includes(capability);
}

export function teamRoleCan(teamRole: TeamRole, capability: TeamCapabilityValue): boolean {
  return TEAM_ROLE_CAPABILITIES[teamRole].includes(capability);
}

// ---------------------------------------------------------------------------
// Access result
// ---------------------------------------------------------------------------

export interface TeamAccess {
  team: Team;
  /** Explicit team membership row, if one exists. */
  teamMembership: TeamMembership | null;
  /** Effective workspace role of the caller. */
  workspaceRole: WorkspaceRole;
}

// ---------------------------------------------------------------------------
// Access guard
// ---------------------------------------------------------------------------

/**
 * Loads the team and proves that the caller can perform the requested
 * capability.
 *
 * The function requires the caller's workspace membership to already be
 * confirmed (i.e. `requireWorkspaceAccess` was called first). Pass the
 * resolved `workspaceRole` from that call.
 *
 * Throws `AppError` with an appropriate status and code on any failure.
 */
export async function requireTeamAccess(
  client: PrismaClient,
  input: {
    userId: string;
    workspaceId: string;
    teamId: string;
    workspaceRole: WorkspaceRole;
    capability: TeamCapabilityValue;
  },
): Promise<TeamAccess> {
  const team = await client.team.findFirst({
    where: {
      id: input.teamId,
      workspaceId: input.workspaceId,
      deletedAt: null,
    },
  });

  if (!team) {
    throw new AppError(404, 'TEAM_NOT_FOUND', 'That team does not exist');
  }

  // Workspace OWNER and PROJECT_MANAGER always have full team access.
  if (workspaceRoleCanOnTeam(input.workspaceRole, input.capability)) {
    return { team, teamMembership: null, workspaceRole: input.workspaceRole };
  }

  // Workspace MEMBER with no explicit team membership can still VIEW teams
  // (they are visible within the workspace).
  if (
    input.workspaceRole === 'MEMBER' &&
    (input.capability === TeamCapability.ViewTeam ||
      input.capability === TeamCapability.ViewMembers)
  ) {
    return { team, teamMembership: null, workspaceRole: input.workspaceRole };
  }

  // For all other workspace roles an explicit team membership row is required.
  const teamMembership = await client.teamMembership.findUnique({
    where: { teamId_userId: { teamId: team.id, userId: input.userId } },
  });

  if (!teamMembership) {
    throw new AppError(403, 'TEAM_ACCESS_DENIED', 'You are not a member of this team');
  }

  if (!teamRoleCan(teamMembership.role, input.capability)) {
    throw new AppError(403, 'INSUFFICIENT_TEAM_ROLE', 'Your team role does not allow this action');
  }

  return { team, teamMembership, workspaceRole: input.workspaceRole };
}
