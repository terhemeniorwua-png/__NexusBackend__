import type {
  PrismaClient,
  ScimGroup,
  ScimToken,
  ScimTokenStatus,
  User,
  WorkspaceMembership,
  WorkspaceRole,
} from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { generateSecureToken, hashSecret } from '../../utils/crypto';
import { AppError } from '../../utils/errors';
import { recordAuditEvent, SecurityAuditAction } from '../../services/audit';
import { requireWorkspaceAccess, WorkspaceCapability } from '../authorization';
import { revokeAllSessions } from '../auth/session.service';
import * as bcrypt from 'bcrypt';

/**
 * SCIM 2.0 provisioning service.
 *
 * Every operation is scoped to a single workspace, identified by the
 * authenticated SCIM bearer token. SCIM users map to Nexus users within the
 * workspace; SCIM groups map to Nexus teams.
 *
 * Deactivation never deletes data unless `hardDelete` is explicitly enabled.
 */

const DEFAULT_SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';

interface ScimServiceDependencies {
  prisma?: PrismaClient;
  now?: () => Date;
}

export interface ScimTokenView {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  scopes: string[];
  status: ScimTokenStatus;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export interface ProvisionScimUserInput {
  workspaceId: string;
  userName: string;
  externalId?: string | null;
  name?: {
    givenName?: string | null;
    familyName?: string | null;
    formatted?: string | null;
  } | null;
  displayName?: string | null;
  emails?: Array<{ value: string; type?: string | null; primary?: boolean } | null>;
  active?: boolean;
  password?: string | null;
  role?: WorkspaceRole;
}

export interface PatchScimUserInput {
  externalId?: string | null;
  displayName?: string | null;
  active?: boolean;
  emails?: Array<{ value: string; type?: string | null; primary?: boolean } | null>;
}

export interface ProvisionScimGroupInput {
  workspaceId: string;
  displayName: string;
  externalId?: string | null;
  teamId?: string | null;
  members?: Array<{ userId: string } | null>;
}

export interface ScimUser {
  id: string;
  externalId: string | null;
  userName: string;
  displayName: string | null;
  name: {
    givenName: string | null;
    familyName: string | null;
    formatted: string | null;
  } | null;
  emails: Array<{ value: string; type: string | null; primary: boolean }>;
  active: boolean;
  groups: Array<{ value: string; display: string | null }>;
  workspaceId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScimGroupResource {
  id: string;
  externalId: string | null;
  displayName: string;
  members: Array<{ value: string; display: string | null }>;
  workspaceId: string;
  teamId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScimService {
  // ------------------------------------------------------------------
  // Tokens
  // ------------------------------------------------------------------
  createToken(input: {
    actorId: string;
    workspaceId: string;
    name: string;
    scopes?: string[];
    expiresAt?: Date | null;
  }): Promise<{ token: string; scimToken: ScimTokenView }>;
  listTokens(input: { actorId: string; workspaceId: string }): Promise<ScimTokenView[]>;
  revokeToken(input: { actorId: string; workspaceId: string; tokenId: string }): Promise<void>;

  // ------------------------------------------------------------------
  // Users
  // ------------------------------------------------------------------
  listUsers(input: {
    actorId: string;
    workspaceId: string;
    startIndex?: number;
    count?: number;
    filter?: string | null;
  }): Promise<ScimListResponse<ScimUser>>;
  createUser(input: { actorId: string } & ProvisionScimUserInput): Promise<ScimUser>;
  getUser(input: { actorId: string; workspaceId: string; scimUserId: string }): Promise<ScimUser>;
  updateUser(input: {
    actorId: string;
    workspaceId: string;
    scimUserId: string;
    patch: PatchScimUserInput;
  }): Promise<ScimUser>;
  deactivateUser(input: {
    actorId: string;
    workspaceId: string;
    scimUserId: string;
    hardDelete?: boolean;
  }): Promise<void>;

  // ------------------------------------------------------------------
  // Groups
  // ------------------------------------------------------------------
  listGroups(input: {
    actorId: string;
    workspaceId: string;
    startIndex?: number;
    count?: number;
  }): Promise<ScimListResponse<ScimGroupResource>>;
  createGroup(input: { actorId: string } & ProvisionScimGroupInput): Promise<ScimGroupResource>;
  getGroup(input: {
    actorId: string;
    workspaceId: string;
    scimGroupId: string;
  }): Promise<ScimGroupResource>;
  updateGroup(input: {
    actorId: string;
    workspaceId: string;
    scimGroupId: string;
    patch: {
      displayName?: string | null;
      externalId?: string | null;
      members?: Array<{ userId: string }> | null;
    };
  }): Promise<ScimGroupResource>;
  deleteGroup(input: {
    actorId: string;
    workspaceId: string;
    scimGroupId: string;
  }): Promise<void>;
}

export function createScimService(
  deps: ScimServiceDependencies = {},
): ScimService {
  const client = deps.prisma ?? getPrismaClient();
  const now = deps.now ?? (() => new Date());

  // ------------------------------------------------------------------
  // Tokens
  // ------------------------------------------------------------------

  async function createToken(input: {
    actorId: string;
    workspaceId: string;
    name: string;
    scopes?: string[];
    expiresAt?: Date | null;
  }): Promise<{ token: string; scimToken: ScimTokenView }> {
    const { workspace } = await requireWorkspaceAccess(client, {
      userId: input.actorId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.UpdateWorkspace,
    });

    const plaintext = generateSecureToken();
    const tokenHash = hashSecret(plaintext);

    const created = await client.scimToken.create({
      data: {
        workspaceId: workspace.id,
        userId: input.actorId,
        name: input.name,
        tokenHash,
        scopes: input.scopes ?? ['scim:read', 'scim:write'],
        expiresAt: input.expiresAt ?? null,
        status: 'ACTIVE',
      },
    });

    await recordAuditEvent(client, {
      workspaceId: workspace.id,
      actorId: input.actorId,
      action: SecurityAuditAction.MemberRoleChanged,
      targetType: 'ScimToken',
      targetId: created.id,
      metadata: { name: created.name, scopes: created.scopes },
    });

    return { token: plaintext, scimToken: toTokenView(created) };
  }

  async function listTokens(input: {
    actorId: string;
    workspaceId: string;
  }): Promise<ScimTokenView[]> {
    const { workspace } = await requireWorkspaceAccess(client, {
      userId: input.actorId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.UpdateWorkspace,
    });

    const tokens = await client.scimToken.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: 'desc' },
    });
    return tokens.map(toTokenView);
  }

  async function revokeToken(input: {
    actorId: string;
    workspaceId: string;
    tokenId: string;
  }): Promise<void> {
    const { workspace } = await requireWorkspaceAccess(client, {
      userId: input.actorId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.UpdateWorkspace,
    });

    const token = await client.scimToken.findFirst({
      where: { id: input.tokenId, workspaceId: workspace.id },
    });
    if (!token) {
      throw new AppError(404, 'SCIM_TOKEN_NOT_FOUND', 'That SCIM token does not exist');
    }

    await client.scimToken.update({
      where: { id: token.id },
      data: { status: 'REVOKED', revokedAt: now() },
    });

    await recordAuditEvent(client, {
      workspaceId: workspace.id,
      actorId: input.actorId,
      action: SecurityAuditAction.MemberRemoved,
      targetType: 'ScimToken',
      targetId: token.id,
      metadata: { name: token.name },
    });
  }

  // ------------------------------------------------------------------
  // Users
  // ------------------------------------------------------------------

  async function listUsers(input: {
    actorId: string;
    workspaceId: string;
    startIndex?: number;
    count?: number;
    filter?: string | null;
  }): Promise<ScimListResponse<ScimUser>> {
    const { workspace } = await requireWorkspaceAccess(client, {
      userId: input.actorId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewMembers,
    });

    const startIndex = Math.max(1, input.startIndex ?? 1);
    const count = Math.min(100, Math.max(1, input.count ?? 20));

    const memberships = await client.workspaceMembership.findMany({
      where: { workspaceId: workspace.id },
      include: { user: true },
      orderBy: { createdAt: 'desc' },
    });

    const total = memberships.length;
    const page = memberships.slice(startIndex - 1, startIndex - 1 + count);

    return {
      schemas: [DEFAULT_SCHEMA_LIST],
      totalResults: total,
      startIndex,
      itemsPerPage: page.length,
      Resources: page.map((m) => toScimUser(m.user, m)),
    };
  }

  async function createUser(input: {
    actorId: string;
  } & ProvisionScimUserInput): Promise<ScimUser> {
    const { workspace } = await requireWorkspaceAccess(client, {
      userId: input.actorId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ManageMembers,
    });

    const existingUser = await client.user.findUnique({
      where: { email: input.userName },
      include: {
        workspaceMemberships: {
          where: { workspaceId: input.workspaceId },
        },
      },
    });

    let user: User;
    let membership: WorkspaceMembership;

    if (existingUser) {
      if (existingUser.deletedAt) {
        throw new AppError(
          409,
          'USER_DEACTIVATED',
          'That account is deactivated and cannot be provisioned',
        );
      }
      const alreadyMember = existingUser.workspaceMemberships.some(
        (m) => m.workspaceId === input.workspaceId,
      );
      if (alreadyMember) {
        return toScimUser(
          existingUser,
          existingUser.workspaceMemberships[0]! as WorkspaceMembership,
        );
      }
      user = existingUser;
      membership = await addMembership(client, input.workspaceId, user.id, input.role);
    } else {
      const displayName =
        input.displayName ?? input.name?.formatted ?? input.userName;

      // passwordHash is a required column, so always store one. When the
      // caller supplies no password, store a hash of a random value so the
      // account must use the password-reset flow before logging in.
      const passwordHash = input.password
        ? await bcrypt.hash(input.password, 10)
        : await bcrypt.hash(generateSecureToken(), 10);

      const created = await client.user.create({
        data: {
          email: input.userName,
          name: displayName,
          status: 'ACTIVE',
          emailVerifiedAt: new Date(),
          passwordHash,
        },
      });
      user = created;
      membership = await addMembership(client, input.workspaceId, user.id, input.role);
    }

    await recordAuditEvent(client, {
      workspaceId: workspace.id,
      actorId: input.actorId,
      action: SecurityAuditAction.MemberRoleChanged,
      targetType: 'User',
      targetId: user.id,
      metadata: { email: user.email, workspaceId: workspace.id },
    });

    return toScimUser(user, membership);
  }

  async function getUser(input: {
    actorId: string;
    workspaceId: string;
    scimUserId: string;
  }): Promise<ScimUser> {
    const { workspace } = await requireWorkspaceAccess(client, {
      userId: input.actorId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewMembers,
    });

    const membership = await client.workspaceMembership.findFirst({
      where: { workspaceId: workspace.id, userId: input.scimUserId },
      include: { user: true },
    });

    if (!membership || membership.user.deletedAt) {
      throw new AppError(404, 'SCIM_USER_NOT_FOUND', 'That SCIM user does not exist');
    }

    return toScimUser(membership.user, membership);
  }

  async function updateUser(input: {
    actorId: string;
    workspaceId: string;
    scimUserId: string;
    patch: PatchScimUserInput;
  }): Promise<ScimUser> {
    const { workspace } = await requireWorkspaceAccess(client, {
      userId: input.actorId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ManageMembers,
    });

    const membership = await client.workspaceMembership.findFirst({
      where: { workspaceId: workspace.id, userId: input.scimUserId },
      include: { user: true },
    });

    if (!membership || membership.user.deletedAt) {
      throw new AppError(404, 'SCIM_USER_NOT_FOUND', 'That SCIM user does not exist');
    }

    const user = membership.user;
    const data: Record<string, unknown> = {};

    if (input.patch.displayName !== undefined) {
      data.name = input.patch.displayName ?? user.name;
    }

    await client.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.user.update({ where: { id: user.id }, data });
      }

      if (input.patch.emails !== undefined) {
        const primary = input.patch.emails.find((e) => e && e.primary);
        const primaryEmail = primary ? primary.value : user.email;
        if (primaryEmail && primaryEmail !== user.email) {
          const conflict = await tx.user.findUnique({ where: { email: primaryEmail } });
          if (conflict && conflict.id !== user.id) {
            throw new AppError(409, 'EMAIL_IN_USE', 'That email address is already in use');
          }
          await tx.user.update({ where: { id: user.id }, data: { email: primaryEmail } });
        }
      }
    });

    await recordAuditEvent(client, {
      workspaceId: workspace.id,
      actorId: input.actorId,
      action: SecurityAuditAction.MemberRoleChanged,
      targetType: 'User',
      targetId: user.id,
      metadata: { patched: Object.keys(input.patch) },
    });

    const refreshed = await client.workspaceMembership.findFirst({
      where: { workspaceId: workspace.id, userId: user.id },
      include: { user: true },
    });
    return toScimUser(refreshed!.user, refreshed!);
  }

  async function deactivateUser(input: {
    actorId: string;
    workspaceId: string;
    scimUserId: string;
    hardDelete?: boolean;
  }): Promise<void> {
    const { workspace } = await requireWorkspaceAccess(client, {
      userId: input.actorId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ManageMembers,
    });

    const membership = await client.workspaceMembership.findFirst({
      where: { workspaceId: workspace.id, userId: input.scimUserId },
      include: { user: true },
    });

    if (!membership || membership.user.deletedAt) {
      throw new AppError(404, 'SCIM_USER_NOT_FOUND', 'That SCIM user does not exist');
    }

    const user = membership.user;

    // Never delete data unless explicitly configured.
    if (input.hardDelete) {
      await client.$transaction(async (tx) => {
        await revokeAllSessions(tx as unknown as PrismaClient, {
          userId: user.id,
          reason: 'SCIM deprovisioning (hard delete)',
        });
        await tx.scimToken.updateMany({
          where: {
            userId: user.id,
            workspaceId: workspace.id,
            status: 'ACTIVE',
          },
          data: { status: 'REVOKED', revokedAt: now() },
        });
        await tx.integration.updateMany({
          where: { userId: user.id, workspaceId: workspace.id },
          data: { enabled: false, revokedAt: new Date(), status: 'ERROR' },
        });
        await tx.workspaceMembership.update({
          where: {
            workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
          },
          data: { status: 'SUSPENDED' },
        });
        await tx.user.delete({ where: { id: user.id } });
      });
    } else {
      await client.$transaction(async (tx) => {
        await revokeAllSessions(tx as unknown as PrismaClient, {
          userId: user.id,
          reason: 'SCIM deprovisioning',
        });
        await tx.scimToken.updateMany({
          where: {
            userId: user.id,
            workspaceId: workspace.id,
            status: 'ACTIVE',
          },
          data: { status: 'REVOKED', revokedAt: now() },
        });
        await tx.integration.updateMany({
          where: { userId: user.id, workspaceId: workspace.id },
          data: { enabled: false, revokedAt: new Date(), status: 'ERROR' },
        });
        await tx.user.update({
          where: { id: user.id },
          data: { status: 'DEACTIVATED' },
        });
        await tx.workspaceMembership.update({
          where: {
            workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
          },
          data: { status: 'SUSPENDED' },
        });
      });
    }

    await recordAuditEvent(client, {
      workspaceId: workspace.id,
      actorId: input.actorId,
      action: SecurityAuditAction.MemberRemoved,
      targetType: 'User',
      targetId: user.id,
      metadata: { email: user.email, hardDelete: !!input.hardDelete },
    });
  }

  // ------------------------------------------------------------------
  // Groups
  // ------------------------------------------------------------------

  async function listGroups(input: {
    actorId: string;
    workspaceId: string;
    startIndex?: number;
    count?: number;
  }): Promise<ScimListResponse<ScimGroupResource>> {
    const { workspace } = await requireWorkspaceAccess(client, {
      userId: input.actorId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });

    const startIndex = Math.max(1, input.startIndex ?? 1);
    const count = Math.min(100, Math.max(1, input.count ?? 20));

    const groups = await client.scimGroup.findMany({
      where: { workspaceId: workspace.id, deletedAt: null },
      include: {
        team: {
          include: {
            members: {
              include: {
                user: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const total = groups.length;
    const page = groups.slice(startIndex - 1, startIndex - 1 + count);

    return {
      schemas: [DEFAULT_SCHEMA_LIST],
      totalResults: total,
      startIndex,
      itemsPerPage: page.length,
      Resources: page.map((g) => toScimGroupResource(g)),
    };
  }

  async function createGroup(input: {
    actorId: string;
  } & ProvisionScimGroupInput): Promise<ScimGroupResource> {
    const { workspace } = await requireWorkspaceAccess(client, {
      userId: input.actorId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ManageMembers,
    });

    let teamId = input.teamId;
    if (teamId) {
      const team = await client.team.findFirst({
        where: { id: teamId, workspaceId: workspace.id, deletedAt: null },
      });
      if (!team) {
        throw new AppError(404, 'TEAM_NOT_FOUND', 'That team does not exist');
      }
    } else {
      const created = await client.team.create({
        data: { workspaceId: workspace.id, name: input.displayName },
      });
      teamId = created.id;
    }

    const existing = await client.scimGroup.findFirst({
      where: {
        workspaceId: workspace.id,
        displayName: input.displayName,
        deletedAt: null,
      },
    });
    if (existing) {
      throw new AppError(409, 'SCIM_GROUP_EXISTS', 'A group with that name already exists');
    }

    const created = await client.scimGroup.create({
      data: {
        workspaceId: workspace.id,
        teamId,
        displayName: input.displayName,
        externalId: input.externalId ?? null,
      },
      include: {
        team: {
          include: {
            members: {
              include: {
                user: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
      },
    });

    // Add initial members to the team.
    for (const member of input.members ?? []) {
      if (!member) continue;
      const targetMembership = await client.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: workspace.id, userId: member.userId },
        },
      });
      if (!targetMembership) {
        throw new AppError(
          404,
          'WORKSPACE_MEMBER_NOT_FOUND',
          'The user you want to add is not a member of this workspace',
        );
      }
      await client.teamMembership.upsert({
        where: { teamId_userId: { teamId, userId: member.userId } },
        update: {},
        create: { teamId, userId: member.userId, role: 'MEMBER' },
      });
    }

    const refreshed = await client.scimGroup.findUnique({
      where: { id: created.id },
      include: {
        team: {
          include: {
            members: {
              include: {
                user: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
      },
    });

    if (!refreshed) {
      throw new AppError(404, 'SCIM_GROUP_NOT_FOUND', 'That SCIM group does not exist');
    }
    return toScimGroupResource(refreshed);
  }

  async function getGroup(input: {
    actorId: string;
    workspaceId: string;
    scimGroupId: string;
  }): Promise<ScimGroupResource> {
    const { workspace } = await requireWorkspaceAccess(client, {
      userId: input.actorId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });

    const group = await client.scimGroup.findFirst({
      where: {
        id: input.scimGroupId,
        workspaceId: workspace.id,
        deletedAt: null,
      },
      include: {
        team: {
          include: {
            members: {
              include: {
                user: { select: { id: true, name: true, email: true } },
              },
            },
          },
        },
      },
    });

    if (!group) {
      throw new AppError(404, 'SCIM_GROUP_NOT_FOUND', 'That SCIM group does not exist');
    }

    return toScimGroupResource(group);
  }

  async function updateGroup(input: {
    actorId: string;
    workspaceId: string;
    scimGroupId: string;
    patch: {
      displayName?: string | null;
      externalId?: string | null;
      members?: Array<{ userId: string }> | null;
    };
  }): Promise<ScimGroupResource> {
    const { workspace } = await requireWorkspaceAccess(client, {
      userId: input.actorId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ManageMembers,
    });

    const group = await client.scimGroup.findFirst({
      where: { id: input.scimGroupId, workspaceId: workspace.id, deletedAt: null },
      include: { team: true },
    });

    if (!group) {
      throw new AppError(404, 'SCIM_GROUP_NOT_FOUND', 'That SCIM group does not exist');
    }

    const data: Record<string, unknown> = {};
    if (input.patch.displayName !== undefined) data.displayName = input.patch.displayName;
    if (input.patch.externalId !== undefined) data.externalId = input.patch.externalId;

    const updated = await client.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.scimGroup.update({ where: { id: group.id }, data });
      }

      if (input.patch.members !== null && input.patch.members !== undefined) {
        const desired = new Set(
          input.patch.members.map((m) => m!.userId).filter(Boolean),
        );

        const current = await tx.teamMembership.findMany({
          where: { teamId: group.teamId },
          select: { id: true, userId: true },
        });

        for (const m of current) {
          if (!desired.has(m.userId)) {
            await tx.teamMembership.delete({ where: { id: m.id } });
          }
        }

        for (const userId of desired) {
          const targetMembership = await tx.workspaceMembership.findUnique({
            where: {
              workspaceId_userId: { workspaceId: workspace.id, userId },
            },
          });
          if (!targetMembership) {
            throw new AppError(
              404,
              'WORKSPACE_MEMBER_NOT_FOUND',
              'The user you want to add is not a member of this workspace',
            );
          }
          await tx.teamMembership.upsert({
            where: { teamId_userId: { teamId: group.teamId, userId } },
            update: {},
            create: { teamId: group.teamId, userId, role: 'MEMBER' },
          });
        }
      }

      return tx.scimGroup.findUnique({
        where: { id: group.id },
        include: {
          team: {
            include: {
              members: {
                include: {
                  user: { select: { id: true, name: true, email: true } },
                },
              },
            },
          },
        },
      });
    });

    if (!updated) {
      throw new AppError(404, 'SCIM_GROUP_NOT_FOUND', 'That SCIM group does not exist');
    }
    return toScimGroupResource(updated);
  }

  async function deleteGroup(input: {
    actorId: string;
    workspaceId: string;
    scimGroupId: string;
  }): Promise<void> {
    const { workspace } = await requireWorkspaceAccess(client, {
      userId: input.actorId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ManageMembers,
    });

    const group = await client.scimGroup.findFirst({
      where: { id: input.scimGroupId, workspaceId: workspace.id, deletedAt: null },
    });

    if (!group) {
      throw new AppError(404, 'SCIM_GROUP_NOT_FOUND', 'That SCIM group does not exist');
    }

    await client.scimGroup.update({
      where: { id: group.id },
      data: { deletedAt: new Date() },
    });

    await recordAuditEvent(client, {
      workspaceId: workspace.id,
      actorId: input.actorId,
      action: SecurityAuditAction.MemberRemoved,
      targetType: 'ScimGroup',
      targetId: group.id,
      metadata: { displayName: group.displayName },
    });
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  async function addMembership(
    tx: PrismaClient,
    workspaceId: string,
    userId: string,
    role?: WorkspaceRole,
  ): Promise<WorkspaceMembership> {
    return tx.workspaceMembership.create({
      data: { workspaceId, userId, role: role ?? 'MEMBER', status: 'ACTIVE' },
    });
  }

  return {
    createToken,
    listTokens,
    revokeToken,
    listUsers,
    createUser,
    getUser,
    updateUser,
    deactivateUser,
    listGroups,
    createGroup,
    getGroup,
    updateGroup,
    deleteGroup,
  };
}

function toTokenView(token: ScimToken & { userId: string }): ScimTokenView {
  return {
    id: token.id,
    workspaceId: token.workspaceId,
    userId: token.userId,
    name: token.name,
    scopes: token.scopes,
    status: token.status,
    expiresAt: token.expiresAt ?? null,
    revokedAt: token.revokedAt ?? null,
    lastUsedAt: token.lastUsedAt ?? null,
    createdAt: token.createdAt,
  };
}

function toScimUser(user: User, membership: WorkspaceMembership): ScimUser {
  return {
    id: user.id,
    externalId: null,
    userName: user.email,
    displayName: user.name || null,
    name: { givenName: null, familyName: null, formatted: user.name || null },
    emails: [{ value: user.email, type: 'work', primary: true }],
    active:
      user.status === 'ACTIVE' &&
      membership.status === 'ACTIVE' &&
      !user.deletedAt,
    groups: [],
    workspaceId: membership.workspaceId,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function toScimGroupResource(group: ScimGroup & {
  team: {
    id: string;
    name: string;
    members: Array<{ user: { id: string; name: string; email: string } }>;
  };
}): ScimGroupResource {
  return {
    id: group.id,
    externalId: group.externalId ?? null,
    displayName: group.displayName,
    members: group.team.members.map((m) => ({
      value: m.user.id,
      display: m.user.name,
    })),
    workspaceId: group.workspaceId,
    teamId: group.teamId,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}
