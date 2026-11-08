import type { PrismaClient, Team, TeamMembership, TeamRole, User } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import type { RequestContext } from '../auth/auth.types';
import { TeamAuditAction, recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { AppError } from '../../utils/errors';
import {
  TeamCapability,
  DepartmentCapability,
  requireDepartmentAccess,
  requireTeamAccess,
  requireWorkspaceAccess,
  WorkspaceCapability,
} from '../authorization';
import type {
  ChangeTeamLeadInput,
  CreateTeamInput,
  UpdateTeamInput,
  UpdateTeamMemberRoleInput,
} from './team.schemas';
import type { TeamMemberSummary, TeamSummary } from './team.types';

/**
 * Teams and their members.
 *
 * A team groups workspace members around a common purpose. Teams can be
 * associated with projects and their members receive targeted notifications.
 *
 * Authorization rules
 * -------------------
 * - The workspace OWNER and PROJECT_MANAGER may create, update, archive,
 *   delete and manage every team in the workspace, regardless of their team
 *   membership.
 * - A TEAM_LEAD may update and manage the members of their own team.
 * - Any workspace MEMBER may view teams and their members.
 * - The role that a client sends in a request body is never trusted.
 */

export interface TeamService {
  create(
    input: { userId: string; workspaceId: string } & CreateTeamInput,
    ctx: RequestContext,
  ): Promise<TeamSummary>;
  list(input: {
    userId: string;
    workspaceId: string;
    includeArchived?: boolean;
  }): Promise<TeamSummary[]>;
  get(input: { userId: string; workspaceId: string; teamId: string }): Promise<TeamSummary>;
  update(
    input: { userId: string; workspaceId: string; teamId: string } & UpdateTeamInput,
    ctx: RequestContext,
  ): Promise<TeamSummary>;
  archive(
    input: { userId: string; workspaceId: string; teamId: string },
    ctx: RequestContext,
  ): Promise<TeamSummary>;
  remove(
    input: { userId: string; workspaceId: string; teamId: string },
    ctx: RequestContext,
  ): Promise<void>;
  listMembers(input: {
    userId: string;
    workspaceId: string;
    teamId: string;
  }): Promise<TeamMemberSummary[]>;
  addMember(
    input: {
      /** The calling user (must have permission to manage members) */
      userId: string;
      workspaceId: string;
      teamId: string;
      /** The workspace member to add to the team */
      targetUserId: string;
      role: TeamRole;
    },
    ctx: RequestContext,
  ): Promise<TeamMemberSummary>;
  updateMemberRole(
    input: {
      userId: string;
      workspaceId: string;
      teamId: string;
      targetUserId: string;
    } & UpdateTeamMemberRoleInput,
    ctx: RequestContext,
  ): Promise<TeamMemberSummary>;
  removeMember(
    input: { userId: string; workspaceId: string; teamId: string; targetUserId: string },
    ctx: RequestContext,
  ): Promise<void>;
  changeLead(
    input: { userId: string; workspaceId: string; teamId: string } & ChangeTeamLeadInput,
    ctx: RequestContext,
  ): Promise<TeamSummary>;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

type TeamWithLead = Team & { lead: Pick<User, 'id' | 'name' | 'email'> | null };

function toSummary(team: TeamWithLead, memberCount: number): TeamSummary {
  return {
    id: team.id,
    workspaceId: team.workspaceId,
    name: team.name,
    description: team.description,
    departmentId: team.departmentId,
    status: team.status,
    leadId: team.leadId,
    lead: team.lead ? { id: team.lead.id, name: team.lead.name, email: team.lead.email } : null,
    memberCount,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

type MembershipWithUser = TeamMembership & {
  user: Pick<User, 'id' | 'name' | 'email'>;
};

function toMember(membership: MembershipWithUser): TeamMemberSummary {
  return {
    id: membership.id,
    userId: membership.user.id,
    teamId: membership.teamId,
    role: membership.role,
    name: membership.user.name,
    email: membership.user.email,
    joinedAt: membership.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTeamService(prisma?: PrismaClient): TeamService {
  const client = prisma ?? getPrismaClient();

  async function loadTeamWithCount(
    teamId: string,
    workspaceId: string,
  ): Promise<{ team: TeamWithLead; memberCount: number }> {
    const row = await client.team.findFirst({
      where: { id: teamId, workspaceId, deletedAt: null },
      include: {
        lead: { select: { id: true, name: true, email: true } },
        _count: { select: { members: true } },
      },
    });

    if (!row) {
      throw new AppError(404, 'TEAM_NOT_FOUND', 'That team does not exist');
    }

    const { _count, ...teamData } = row;

    return { team: teamData, memberCount: _count.members };
  }

  return {
    async create(input, ctx): Promise<TeamSummary> {
      // Creating a team requires workspace update permission.
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.UpdateWorkspace,
      });

      // Validate leadId if provided — the lead must be a workspace member.
      if (input.leadId) {
        const leadWorkspaceMembership = await client.workspaceMembership.findUnique({
          where: {
            workspaceId_userId: { workspaceId: workspace.id, userId: input.leadId },
          },
        });

        if (!leadWorkspaceMembership) {
          throw new AppError(
            404,
            'LEAD_NOT_FOUND',
            'The team lead must be a member of the workspace',
          );
        }
      }

      if (input.departmentId) {
        await requireDepartmentAccess(client, {
          userId: input.userId,
          workspaceId: workspace.id,
          departmentId: input.departmentId,
          capability: DepartmentCapability.ManageTeams,
        });
      }

      const creatorRole: TeamRole =
        membership.role === 'OWNER' || membership.role === 'PROJECT_MANAGER'
          ? 'TEAM_LEAD'
          : 'MEMBER';

      const team = await client.$transaction(async (tx) => {
        const created = await tx.team.create({
          data: {
            workspaceId: workspace.id,
            name: input.name,
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
            ...(input.leadId !== undefined ? { leadId: input.leadId } : {}),
          },
          include: {
            lead: { select: { id: true, name: true, email: true } },
          },
        });

        // Add the creator as a team member automatically.
        await tx.teamMembership.create({
          data: {
            teamId: created.id,
            userId: input.userId,
            role: creatorRole,
          },
        });

        // If a separate lead was specified and is not the creator, add them too.
        if (input.leadId && input.leadId !== input.userId) {
          await tx.teamMembership.create({
            data: {
              teamId: created.id,
              userId: input.leadId,
              role: 'TEAM_LEAD',
            },
          });
        }

        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: TeamAuditAction.TeamCreated,
          targetType: 'Team',
          targetId: created.id,
          metadata: {
            name: created.name,
            ...(created.leadId ? { leadId: created.leadId } : {}),
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return created;
      });

      // Notify the lead if one was set and is not the creator.
      if (input.leadId && input.leadId !== input.userId) {
        await createNotification(client, {
          userId: input.leadId,
          type: 'MEMBERSHIP_CHANGED',
          title: `You are the lead of ${team.name}`,
          body: `You have been assigned as the team lead of ${team.name}.`,
          data: { workspaceId: workspace.id, teamId: team.id, role: 'TEAM_LEAD' },
        });
      }

      const memberCount = 1 + (input.leadId && input.leadId !== input.userId ? 1 : 0);

      return toSummary(team, memberCount);
    },

    async list(input): Promise<TeamSummary[]> {
      // Any workspace member may list teams.
      const { workspace } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const teams = await client.team.findMany({
        where: {
          workspaceId: workspace.id,
          deletedAt: null,
          ...(input.includeArchived ? {} : { status: 'ACTIVE' }),
        },
        include: {
          lead: { select: { id: true, name: true, email: true } },
          _count: { select: { members: true } },
        },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
      });

      return teams.map(({ _count, ...team }) => toSummary(team, _count.members));
    },

    async get(input): Promise<TeamSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      await requireTeamAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        teamId: input.teamId,
        workspaceRole: membership.role,
        capability: TeamCapability.ViewTeam,
      });

      const { team, memberCount } = await loadTeamWithCount(input.teamId, workspace.id);

      return toSummary(team, memberCount);
    },

    async update(input, ctx): Promise<TeamSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const { team } = await requireTeamAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        teamId: input.teamId,
        workspaceRole: membership.role,
        capability: TeamCapability.UpdateTeam,
      });

      if (input.departmentId !== undefined && input.departmentId !== team.departmentId) {
        if (team.departmentId) {
          await requireDepartmentAccess(client, {
            userId: input.userId,
            workspaceId: workspace.id,
            departmentId: team.departmentId,
            capability: DepartmentCapability.ManageTeams,
          });
        }
        if (input.departmentId) {
          await requireDepartmentAccess(client, {
            userId: input.userId,
            workspaceId: workspace.id,
            departmentId: input.departmentId,
            capability: DepartmentCapability.ManageTeams,
          });
        }
      }

      const updatedTeam = await client.$transaction(async (tx) => {
        const changed = await tx.team.update({
          where: { id: input.teamId },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
          },
          include: {
            lead: { select: { id: true, name: true, email: true } },
          },
        });

        if (input.departmentId !== undefined && input.departmentId !== team.departmentId) {
          await tx.project.updateMany({
            where: { teamId: team.id, departmentId: team.departmentId },
            data: { departmentId: changed.departmentId },
          });
        }

        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: TeamAuditAction.TeamUpdated,
          targetType: 'Team',
          targetId: changed.id,
          metadata: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.departmentId !== undefined
              ? { previousDepartmentId: team.departmentId, departmentId: changed.departmentId }
              : {}),
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return changed;
      });

      const memberCount = await client.teamMembership.count({
        where: { teamId: updatedTeam.id },
      });

      return toSummary(updatedTeam, memberCount);
    },

    async archive(input, ctx): Promise<TeamSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      await requireTeamAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        teamId: input.teamId,
        workspaceRole: membership.role,
        capability: TeamCapability.ArchiveTeam,
      });

      const archived = await client.$transaction(async (tx) => {
        const changed = await tx.team.update({
          where: { id: input.teamId },
          data: { status: 'ARCHIVED' },
          include: {
            lead: { select: { id: true, name: true, email: true } },
          },
        });

        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: TeamAuditAction.TeamArchived,
          targetType: 'Team',
          targetId: changed.id,
          metadata: { name: changed.name },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return changed;
      });

      const memberCount = await client.teamMembership.count({
        where: { teamId: archived.id },
      });

      return toSummary(archived, memberCount);
    },

    async remove(input, ctx): Promise<void> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const { team } = await requireTeamAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        teamId: input.teamId,
        workspaceRole: membership.role,
        capability: TeamCapability.DeleteTeam,
      });

      // Collect the team members before the soft delete so we can notify them.
      const members = await client.teamMembership.findMany({
        where: { teamId: team.id },
        select: { userId: true },
      });

      await client.$transaction(async (tx) => {
        await tx.team.update({
          where: { id: team.id },
          data: { deletedAt: new Date(), status: 'ARCHIVED' },
        });

        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: TeamAuditAction.TeamDeleted,
          targetType: 'Team',
          targetId: team.id,
          metadata: { name: team.name },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        // Notify team members that the team was deleted.
        for (const m of members) {
          if (m.userId !== input.userId) {
            await createNotification(tx, {
              userId: m.userId,
              type: 'MEMBERSHIP_CHANGED',
              title: `Team "${team.name}" was deleted`,
              body: `The team ${team.name} has been removed from the workspace.`,
              data: { workspaceId: workspace.id, teamId: team.id },
            });
          }
        }
      });
    },

    async listMembers(input): Promise<TeamMemberSummary[]> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      await requireTeamAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        teamId: input.teamId,
        workspaceRole: membership.role,
        capability: TeamCapability.ViewMembers,
      });

      const memberships = await client.teamMembership.findMany({
        where: { teamId: input.teamId },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      });

      return memberships.map(toMember);
    },

    async addMember(input, ctx): Promise<TeamMemberSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const { team } = await requireTeamAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        teamId: input.teamId,
        workspaceRole: membership.role,
        capability: TeamCapability.ManageMembers,
      });

      // The user being added must be a workspace member.
      const targetWorkspaceMembership = await client.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: workspace.id, userId: input.targetUserId },
        },
        include: { user: { select: { id: true, name: true, email: true } } },
      });

      if (!targetWorkspaceMembership) {
        throw new AppError(
          404,
          'WORKSPACE_MEMBER_NOT_FOUND',
          'The user you want to add is not a member of this workspace',
        );
      }

      // Check they are not already a team member.
      const existing = await client.teamMembership.findUnique({
        where: { teamId_userId: { teamId: team.id, userId: input.targetUserId } },
      });

      if (existing) {
        throw new AppError(409, 'ALREADY_A_MEMBER', 'This user is already a member of the team');
      }

      const newMembership = await client.$transaction(async (tx) => {
        const created = await tx.teamMembership.create({
          data: {
            teamId: team.id,
            userId: input.targetUserId,
            role: input.role,
          },
          include: { user: { select: { id: true, name: true, email: true } } },
        });

        // If the new member is added as TEAM_LEAD, update the team's leadId.
        if (input.role === 'TEAM_LEAD') {
          await tx.team.update({
            where: { id: team.id },
            data: { leadId: input.targetUserId },
          });
        }

        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: TeamAuditAction.MemberAdded,
          targetType: 'TeamMembership',
          targetId: created.id,
          metadata: {
            teamId: team.id,
            userId: input.targetUserId,
            email: targetWorkspaceMembership.user.email,
            role: input.role,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        await createNotification(tx, {
          userId: input.targetUserId,
          type: 'MEMBERSHIP_CHANGED',
          title: `You joined ${team.name}`,
          body: `Your role in the team is ${input.role === 'TEAM_LEAD' ? 'Team Lead' : 'Member'}.`,
          data: { workspaceId: workspace.id, teamId: team.id, role: input.role },
        });

        return created;
      });

      return toMember(newMembership);
    },

    async updateMemberRole(input, ctx): Promise<TeamMemberSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const { team } = await requireTeamAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        teamId: input.teamId,
        workspaceRole: membership.role,
        capability: TeamCapability.ManageMembers,
      });

      const target = await client.teamMembership.findUnique({
        where: { teamId_userId: { teamId: team.id, userId: input.targetUserId } },
        include: { user: { select: { id: true, name: true, email: true } } },
      });

      if (!target) {
        throw new AppError(404, 'MEMBER_NOT_FOUND', 'That user is not a member of this team');
      }

      const updated = await client.$transaction(async (tx) => {
        const previousRole = target.role;
        const changed = await tx.teamMembership.update({
          where: { id: target.id },
          data: { role: input.role as TeamRole },
          include: { user: { select: { id: true, name: true, email: true } } },
        });

        // If the new role is TEAM_LEAD, update the team's leadId.
        if (input.role === 'TEAM_LEAD') {
          await tx.team.update({
            where: { id: team.id },
            data: { leadId: input.targetUserId },
          });
        } else if (team.leadId === input.targetUserId) {
          // If demoting the current lead, clear the leadId.
          await tx.team.update({
            where: { id: team.id },
            data: { leadId: null },
          });
        }

        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: TeamAuditAction.MemberRoleChanged,
          targetType: 'TeamMembership',
          targetId: changed.id,
          metadata: {
            teamId: team.id,
            userId: changed.user.id,
            previousRole,
            role: input.role,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        await createNotification(tx, {
          userId: changed.user.id,
          type: 'MEMBERSHIP_CHANGED',
          title: `Your role in ${team.name} changed`,
          body: `Your team role is now ${input.role === 'TEAM_LEAD' ? 'Team Lead' : 'Member'}.`,
          data: { workspaceId: workspace.id, teamId: team.id, role: input.role },
        });

        return changed;
      });

      return toMember(updated);
    },

    async removeMember(input, ctx): Promise<void> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const { team } = await requireTeamAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        teamId: input.teamId,
        workspaceRole: membership.role,
        capability: TeamCapability.ManageMembers,
      });

      const target = await client.teamMembership.findUnique({
        where: { teamId_userId: { teamId: team.id, userId: input.targetUserId } },
        include: { user: { select: { id: true, name: true, email: true } } },
      });

      if (!target) {
        throw new AppError(404, 'MEMBER_NOT_FOUND', 'That user is not a member of this team');
      }

      await client.$transaction(async (tx) => {
        await tx.teamMembership.delete({ where: { id: target.id } });

        // If the removed member was the team lead, clear the lead.
        if (team.leadId === input.targetUserId) {
          await tx.team.update({
            where: { id: team.id },
            data: { leadId: null },
          });
        }

        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: TeamAuditAction.MemberRemoved,
          targetType: 'TeamMembership',
          targetId: target.id,
          metadata: {
            teamId: team.id,
            userId: target.user.id,
            email: target.user.email,
            role: target.role,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        if (target.userId !== input.userId) {
          await createNotification(tx, {
            userId: target.userId,
            type: 'MEMBERSHIP_CHANGED',
            title: `You were removed from ${team.name}`,
            body: `Your membership in the team ${team.name} was removed.`,
            data: { workspaceId: workspace.id, teamId: team.id },
          });
        }
      });
    },

    async changeLead(input, ctx): Promise<TeamSummary> {
      const { workspace, membership } = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      await requireTeamAccess(client, {
        userId: input.userId,
        workspaceId: workspace.id,
        teamId: input.teamId,
        workspaceRole: membership.role,
        capability: TeamCapability.ManageMembers,
      });

      // If a new lead is specified, they must be a workspace member.
      if (input.leadId !== null) {
        const leadWorkspaceMembership = await client.workspaceMembership.findUnique({
          where: {
            workspaceId_userId: { workspaceId: workspace.id, userId: input.leadId },
          },
        });

        if (!leadWorkspaceMembership) {
          throw new AppError(
            404,
            'LEAD_NOT_FOUND',
            'The new lead must be a member of the workspace',
          );
        }
      }

      const updatedTeam = await client.$transaction(async (tx) => {
        const currentTeam = await tx.team.findFirst({
          where: { id: input.teamId, workspaceId: workspace.id, deletedAt: null },
        });

        if (!currentTeam) {
          throw new AppError(404, 'TEAM_NOT_FOUND', 'That team does not exist');
        }

        const previousLeadId = currentTeam.leadId;

        const changed = await tx.team.update({
          where: { id: input.teamId },
          data: { leadId: input.leadId },
          include: {
            lead: { select: { id: true, name: true, email: true } },
          },
        });

        // Downgrade the previous lead to MEMBER (if they still have a membership row).
        if (previousLeadId && previousLeadId !== input.leadId) {
          const prevLeadMembership = await tx.teamMembership.findUnique({
            where: { teamId_userId: { teamId: input.teamId, userId: previousLeadId } },
          });

          if (prevLeadMembership?.role === 'TEAM_LEAD') {
            await tx.teamMembership.update({
              where: { id: prevLeadMembership.id },
              data: { role: 'MEMBER' },
            });
          }
        }

        // Ensure the new lead has a team membership row with TEAM_LEAD role.
        if (input.leadId) {
          const existingMembership = await tx.teamMembership.findUnique({
            where: { teamId_userId: { teamId: input.teamId, userId: input.leadId } },
          });

          if (existingMembership) {
            await tx.teamMembership.update({
              where: { id: existingMembership.id },
              data: { role: 'TEAM_LEAD' },
            });
          } else {
            await tx.teamMembership.create({
              data: {
                teamId: input.teamId,
                userId: input.leadId,
                role: 'TEAM_LEAD',
              },
            });
          }
        }

        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: input.userId,
          action: TeamAuditAction.LeadChanged,
          targetType: 'Team',
          targetId: changed.id,
          metadata: {
            previousLeadId,
            newLeadId: input.leadId,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        if (input.leadId && input.leadId !== input.userId) {
          await createNotification(tx, {
            userId: input.leadId,
            type: 'MEMBERSHIP_CHANGED',
            title: `You are now the lead of ${changed.name}`,
            body: `You have been assigned as the team lead of ${changed.name}.`,
            data: { workspaceId: workspace.id, teamId: changed.id, role: 'TEAM_LEAD' },
          });
        }

        return changed;
      });

      const memberCount = await client.teamMembership.count({
        where: { teamId: updatedTeam.id },
      });

      return toSummary(updatedTeam, memberCount);
    },
  };
}
