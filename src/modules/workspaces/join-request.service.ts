import { Prisma } from '@prisma/client';
import type { JoinRequest, PrismaClient, WorkspaceRole } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import type { RequestContext } from '../auth/auth.types';
import { recordAuditEvent, WorkspaceAuditAction } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { generateSecureToken, hashSecret } from '../../utils/crypto';
import { AppError } from '../../utils/errors';
import { assertMayAssignRole, requireWorkspaceAccess, WorkspaceCapability } from './authorization';
import type {
  ApproveJoinRequestInput,
  CreateJoinRequestInput,
  JoinByCodeInput,
  ListJoinRequestsQuery,
  RejectJoinRequestInput,
} from './workspace.schemas';
import type { DiscoveredWorkspace, JoinCodeResult, JoinRequestSummary } from './workspace.types';

/**
 * Organisation discovery and join requests.
 *
 * Discovery only lists workspaces an administrator has made PUBLIC. A join
 * request is a request, never a membership: nothing is granted until an
 * administrator approves it, and a matching email domain alone never creates
 * membership.
 *
 * A pending request is unique per applicant and workspace through the
 * `pendingKey` column, and it expires after seven days by default.
 */

export interface JoinRequestService {
  discover(input: {
    search?: string | undefined;
    limit: number;
    offset: number;
  }): Promise<DiscoveredWorkspace[]>;
  create(
    input: { userId: string; workspaceId: string } & CreateJoinRequestInput,
    ctx: RequestContext,
  ): Promise<JoinRequestSummary>;
  createByCode(
    input: { userId: string } & JoinByCodeInput,
    ctx: RequestContext,
  ): Promise<JoinRequestSummary>;
  listMine(userId: string): Promise<JoinRequestSummary[]>;
  listForWorkspace(input: {
    userId: string;
    workspaceId: string;
    status: ListJoinRequestsQuery['status'];
  }): Promise<JoinRequestSummary[]>;
  approve(
    input: { userId: string; workspaceId: string; requestId: string } & ApproveJoinRequestInput,
    ctx: RequestContext,
  ): Promise<JoinRequestSummary>;
  reject(
    input: { userId: string; workspaceId: string; requestId: string } & RejectJoinRequestInput,
    ctx: RequestContext,
  ): Promise<JoinRequestSummary>;
  withdraw(
    input: { userId: string; requestId: string },
    ctx: RequestContext,
  ): Promise<JoinRequestSummary>;
  rotateCode(
    input: { userId: string; workspaceId: string },
    ctx: RequestContext,
  ): Promise<JoinCodeResult>;
  disableCode(
    input: { userId: string; workspaceId: string },
    ctx: RequestContext,
  ): Promise<{ workspaceId: string; joinCodeEnabled: false }>;
}

type JoinRequestWithRelations = JoinRequest & {
  workspace: { id: string; name: string };
  user: { id: string; name: string; email: string };
  reviewedBy: { id: string; name: string } | null;
};

const summaryInclude = {
  workspace: { select: { id: true, name: true } },
  user: { select: { id: true, name: true, email: true } },
  reviewedBy: { select: { id: true, name: true } },
} as const;

function pendingKeyFor(workspaceId: string, userId: string): string {
  return `join:${workspaceId}:${userId}`;
}

function toSummary(request: JoinRequestWithRelations): JoinRequestSummary {
  return {
    id: request.id,
    workspaceId: request.workspaceId,
    workspaceName: request.workspace.name,
    userId: request.user.id,
    userName: request.user.name,
    userEmail: request.user.email,
    status: request.status,
    role: request.role,
    teamId: request.teamId,
    message: request.message,
    reviewedBy: request.reviewedBy,
    reviewedAt: request.reviewedAt,
    decisionNote: request.decisionNote,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

async function transitionPendingRequest(
  tx: Prisma.TransactionClient,
  where: { id: string; workspaceId?: string; userId?: string },
  data: Prisma.JoinRequestUncheckedUpdateManyInput,
): Promise<JoinRequest> {
  const result = await tx.joinRequest.updateMany({
    where: { ...where, status: 'PENDING', expiresAt: { gt: new Date() } },
    data,
  });

  if (result.count !== 1) {
    throw new AppError(409, 'JOIN_REQUEST_NOT_PENDING', 'This join request is no longer pending');
  }

  return tx.joinRequest.findUniqueOrThrow({ where: { id: where.id } });
}

export function createJoinRequestService(
  config: AppConfig,
  prisma?: PrismaClient,
): JoinRequestService {
  const client = prisma ?? getPrismaClient();

  const workspaceLink = (workspaceId: string): string =>
    `${config.frontendUrl.replace(/\/+$/, '')}/workspaces/${workspaceId}`;

  async function expireStale(workspaceId?: string): Promise<void> {
    await client.joinRequest.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lte: new Date() },
        ...(workspaceId ? { workspaceId } : {}),
      },
      data: { status: 'EXPIRED', pendingKey: null },
    });
  }

  async function loadJoinableWorkspace(workspaceId: string) {
    const workspace = await client.workspace.findFirst({
      where: { id: workspaceId, deletedAt: null },
      select: {
        id: true,
        name: true,
        type: true,
        visibility: true,
        status: true,
        joinCodeHash: true,
      },
    });

    if (!workspace) {
      throw new AppError(404, 'WORKSPACE_NOT_FOUND', 'That workspace does not exist');
    }

    if (workspace.status !== 'ACTIVE') {
      throw new AppError(
        409,
        'WORKSPACE_NOT_ACTIVE',
        'This workspace is not accepting join requests',
      );
    }

    if (workspace.type === 'INDIVIDUAL') {
      throw new AppError(
        409,
        'WORKSPACE_NOT_JOINABLE',
        'A personal workspace does not accept join requests',
      );
    }

    return workspace;
  }

  async function createRequest(
    input: { userId: string; workspaceId: string; message?: string | null },
    ctx: RequestContext,
    options: { requirePublic: boolean },
  ): Promise<JoinRequestSummary> {
    const workspace = await loadJoinableWorkspace(input.workspaceId);

    if (options.requirePublic && workspace.visibility !== 'PUBLIC') {
      throw new AppError(
        403,
        'WORKSPACE_NOT_DISCOVERABLE',
        'This workspace does not accept requests from discovery. Use a join link or code.',
      );
    }

    const user = await client.user.findUnique({
      where: { id: input.userId },
      select: { id: true, name: true, email: true, status: true, deletedAt: true },
    });

    if (!user || user.deletedAt) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
    }

    if (user.status !== 'ACTIVE') {
      throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'This account cannot request membership');
    }

    const membership = await client.workspaceMembership.findUnique({
      where: {
        workspaceId_userId: { workspaceId: workspace.id, userId: user.id },
      },
      select: { status: true },
    });

    if (membership) {
      throw new AppError(
        409,
        membership.status === 'SUSPENDED' ? 'MEMBERSHIP_SUSPENDED' : 'ALREADY_A_MEMBER',
        membership.status === 'SUSPENDED'
          ? 'Your membership is suspended. Ask an administrator to restore it.'
          : 'You are already a member of this workspace',
      );
    }

    await expireStale(workspace.id);

    const pending = await client.joinRequest.findFirst({
      where: { workspaceId: workspace.id, userId: user.id, status: 'PENDING' },
      select: { id: true },
    });

    if (pending) {
      throw new AppError(
        409,
        'JOIN_REQUEST_EXISTS',
        'You already have a pending request for this workspace',
      );
    }

    const expiresAt = new Date(Date.now() + config.workspaceJoinRequestTtlSeconds * 1_000);

    let created: JoinRequest;
    try {
      created = await client.$transaction(async (tx) => {
        const request = await tx.joinRequest.create({
          data: {
            workspaceId: workspace.id,
            userId: user.id,
            status: 'PENDING',
            role: 'MEMBER',
            message: input.message ?? null,
            expiresAt,
            pendingKey: pendingKeyFor(workspace.id, user.id),
          },
        });

        await recordAuditEvent(tx, {
          workspaceId: workspace.id,
          actorId: user.id,
          action: WorkspaceAuditAction.JoinRequestCreated,
          targetType: 'JoinRequest',
          targetId: request.id,
          metadata: {
            userId: user.id,
            // The domain is recorded for administrators. It never grants
            // membership on its own.
            emailDomain: user.email.split('@')[1] ?? null,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        const managers = await tx.workspaceMembership.findMany({
          where: {
            workspaceId: workspace.id,
            status: 'ACTIVE',
            role: { in: ['OWNER', 'PROJECT_MANAGER'] },
          },
          select: { userId: true },
        });

        for (const manager of managers) {
          await createNotification(tx, {
            userId: manager.userId,
            type: 'JOIN_REQUEST_RECEIVED',
            title: `${user.name} asked to join ${workspace.name}`,
            body: input.message ?? 'Open the workspace to approve or reject the request.',
            link: workspaceLink(workspace.id),
            data: { workspaceId: workspace.id, requestId: request.id, userId: user.id },
          });
        }

        return request;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(
          409,
          'JOIN_REQUEST_EXISTS',
          'You already have a pending request for this workspace',
        );
      }

      throw error;
    }

    const stored = await client.joinRequest.findUnique({
      where: { id: created.id },
      include: summaryInclude,
    });

    if (!stored) {
      throw new AppError(500, 'JOIN_REQUEST_NOT_STORED', 'The join request could not be stored');
    }

    return toSummary(stored);
  }

  return {
    async discover(input): Promise<DiscoveredWorkspace[]> {
      const workspaces = await client.workspace.findMany({
        where: {
          visibility: 'PUBLIC',
          status: 'ACTIVE',
          deletedAt: null,
          type: { not: 'INDIVIDUAL' },
          ...(input.search
            ? {
                OR: [
                  { name: { contains: input.search, mode: 'insensitive' as const } },
                  { slug: { contains: input.search, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          type: true,
          _count: { select: { members: true } },
        },
        orderBy: { name: 'asc' },
        take: input.limit,
        skip: input.offset,
      });

      return workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        description: workspace.description,
        type: workspace.type,
        memberCount: workspace._count.members,
      }));
    },

    async create(input, ctx): Promise<JoinRequestSummary> {
      return createRequest(input, ctx, { requirePublic: true });
    },

    async createByCode(input, ctx): Promise<JoinRequestSummary> {
      const workspace = await client.workspace.findUnique({
        where: { joinCodeHash: hashSecret(input.code) },
        select: { id: true },
      });

      if (!workspace) {
        throw new AppError(404, 'JOIN_CODE_NOT_FOUND', 'This join code is not valid');
      }

      return createRequest(
        { userId: input.userId, workspaceId: workspace.id, message: input.message },
        ctx,
        { requirePublic: false },
      );
    },

    async listMine(userId): Promise<JoinRequestSummary[]> {
      await expireStale();

      const requests = await client.joinRequest.findMany({
        where: { userId },
        include: summaryInclude,
        orderBy: { createdAt: 'desc' },
      });

      return requests.map(toSummary);
    },

    async listForWorkspace(input): Promise<JoinRequestSummary[]> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewJoinRequests,
      });

      await expireStale(access.workspace.id);

      const requests = await client.joinRequest.findMany({
        where: {
          workspaceId: access.workspace.id,
          ...(input.status === 'ALL' ? {} : { status: input.status }),
        },
        include: summaryInclude,
        orderBy: { createdAt: 'desc' },
      });

      return requests.map(toSummary);
    },

    async approve(input, ctx): Promise<JoinRequestSummary> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ManageJoinRequests,
      });

      const request = await client.joinRequest.findFirst({
        where: { id: input.requestId, workspaceId: access.workspace.id },
        include: { user: { select: { id: true, name: true, email: true, deletedAt: true } } },
      });

      if (!request) {
        throw new AppError(404, 'JOIN_REQUEST_NOT_FOUND', 'That join request does not exist');
      }

      if (request.status !== 'PENDING' || request.expiresAt.getTime() <= Date.now()) {
        if (request.status === 'PENDING') {
          await client.joinRequest.update({
            where: { id: request.id },
            data: { status: 'EXPIRED', pendingKey: null },
          });
        }

        throw new AppError(
          request.status === 'PENDING' ? 410 : 409,
          request.status === 'PENDING' ? 'JOIN_REQUEST_EXPIRED' : 'JOIN_REQUEST_NOT_PENDING',
          request.status === 'PENDING'
            ? 'This join request has expired'
            : 'This join request can no longer be approved',
        );
      }

      if (request.user.deletedAt) {
        throw new AppError(
          409,
          'APPLICANT_UNAVAILABLE',
          'The applicant account is no longer active',
        );
      }

      const role = (input.role ?? request.role) as WorkspaceRole;
      assertMayAssignRole({ actorRole: access.membership.role, requestedRole: role });

      const teamId = input.teamId ?? null;

      if (teamId) {
        const team = await client.team.findFirst({
          where: {
            id: teamId,
            workspaceId: access.workspace.id,
            deletedAt: null,
            status: 'ACTIVE',
          },
          select: { id: true },
        });

        if (!team) {
          throw new AppError(
            400,
            'TEAM_NOT_IN_WORKSPACE',
            'That team does not belong to this workspace',
          );
        }
      }

      const existingMembership = await client.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: access.workspace.id, userId: request.user.id },
        },
        select: { id: true, status: true },
      });

      if (existingMembership) {
        throw new AppError(
          409,
          existingMembership.status === 'SUSPENDED' ? 'MEMBERSHIP_SUSPENDED' : 'ALREADY_A_MEMBER',
          existingMembership.status === 'SUSPENDED'
            ? 'A suspended membership must be restored instead of approved'
            : 'The applicant is already a member of this workspace',
        );
      }

      const approved = await client
        .$transaction(async (tx) => {
          const changed = await transitionPendingRequest(
            tx,
            { id: request.id, workspaceId: access.workspace.id },
            {
              status: 'APPROVED',
              role,
              teamId,
              reviewedById: input.userId,
              reviewedAt: new Date(),
              pendingKey: null,
            },
          );

          const membership = await tx.workspaceMembership.create({
            data: {
              workspaceId: access.workspace.id,
              userId: request.user.id,
              role,
              status: 'ACTIVE',
            },
          });

          if (teamId) {
            await tx.teamMembership.upsert({
              where: { teamId_userId: { teamId, userId: request.user.id } },
              create: { teamId, userId: request.user.id, role: 'MEMBER' },
              update: {},
            });
          }

          await recordAuditEvent(tx, {
            workspaceId: access.workspace.id,
            actorId: input.userId,
            action: WorkspaceAuditAction.JoinRequestApproved,
            targetType: 'JoinRequest',
            targetId: changed.id,
            metadata: { userId: request.user.id, role, teamId },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });

          await recordAuditEvent(tx, {
            workspaceId: access.workspace.id,
            actorId: input.userId,
            action: WorkspaceAuditAction.MemberAdded,
            targetType: 'WorkspaceMembership',
            targetId: membership.id,
            metadata: { userId: request.user.id, role, source: 'join_request' },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });

          await createNotification(tx, {
            userId: request.user.id,
            type: 'JOIN_REQUEST_APPROVED',
            title: `You joined ${access.workspace.name}`,
            body: `Your request to join ${access.workspace.name} was approved.`,
            link: workspaceLink(access.workspace.id),
            data: { workspaceId: access.workspace.id, role, teamId },
          });

          return changed;
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw new AppError(
              409,
              'ALREADY_A_MEMBER',
              'The applicant already belongs to this workspace',
            );
          }

          throw error;
        });

      const stored = await client.joinRequest.findUnique({
        where: { id: approved.id },
        include: summaryInclude,
      });

      if (!stored) {
        throw new AppError(500, 'JOIN_REQUEST_NOT_STORED', 'The join request could not be stored');
      }

      return toSummary(stored);
    },

    async reject(input, ctx): Promise<JoinRequestSummary> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ManageJoinRequests,
      });

      const request = await client.joinRequest.findFirst({
        where: { id: input.requestId, workspaceId: access.workspace.id },
        include: { user: { select: { id: true, name: true, email: true } } },
      });

      if (!request) {
        throw new AppError(404, 'JOIN_REQUEST_NOT_FOUND', 'That join request does not exist');
      }

      if (request.status !== 'PENDING') {
        throw new AppError(
          409,
          'JOIN_REQUEST_NOT_PENDING',
          'This join request is no longer pending',
        );
      }

      if (request.expiresAt.getTime() <= Date.now()) {
        await client.joinRequest.update({
          where: { id: request.id },
          data: { status: 'EXPIRED', pendingKey: null },
        });

        throw new AppError(410, 'JOIN_REQUEST_EXPIRED', 'This join request has expired');
      }

      const rejected = await client.$transaction(async (tx) => {
        const changed = await transitionPendingRequest(
          tx,
          { id: request.id, workspaceId: access.workspace.id },
          {
            status: 'REJECTED',
            reviewedById: input.userId,
            reviewedAt: new Date(),
            decisionNote: input.note ?? null,
            pendingKey: null,
          },
        );

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.JoinRequestRejected,
          targetType: 'JoinRequest',
          targetId: changed.id,
          metadata: { userId: request.user.id },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        await createNotification(tx, {
          userId: request.user.id,
          type: 'JOIN_REQUEST_REJECTED',
          title: `Your request to join ${access.workspace.name} was declined`,
          body: input.note ?? 'An administrator declined your join request.',
          link: workspaceLink(access.workspace.id),
          data: { workspaceId: access.workspace.id },
        });

        return changed;
      });

      const stored = await client.joinRequest.findUnique({
        where: { id: rejected.id },
        include: summaryInclude,
      });

      if (!stored) {
        throw new AppError(500, 'JOIN_REQUEST_NOT_STORED', 'The join request could not be stored');
      }

      return toSummary(stored);
    },

    async withdraw(input, ctx): Promise<JoinRequestSummary> {
      const request = await client.joinRequest.findFirst({
        where: { id: input.requestId, userId: input.userId },
        include: summaryInclude,
      });

      if (!request) {
        throw new AppError(404, 'JOIN_REQUEST_NOT_FOUND', 'That join request does not exist');
      }

      if (request.status !== 'PENDING') {
        throw new AppError(
          409,
          'JOIN_REQUEST_NOT_PENDING',
          'This join request is no longer pending',
        );
      }

      if (request.expiresAt.getTime() <= Date.now()) {
        await client.joinRequest.updateMany({
          where: { id: request.id, status: 'PENDING', expiresAt: { lte: new Date() } },
          data: { status: 'EXPIRED', pendingKey: null },
        });
        throw new AppError(410, 'JOIN_REQUEST_EXPIRED', 'This join request has expired');
      }

      const withdrawn = await client.$transaction(async (tx) => {
        const changed = await transitionPendingRequest(
          tx,
          { id: request.id, userId: input.userId },
          { status: 'WITHDRAWN', pendingKey: null },
        );

        await recordAuditEvent(tx, {
          workspaceId: request.workspaceId,
          actorId: input.userId,
          action: WorkspaceAuditAction.JoinRequestWithdrawn,
          targetType: 'JoinRequest',
          targetId: changed.id,
          metadata: { userId: input.userId },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return changed;
      });

      const stored = await client.joinRequest.findUnique({
        where: { id: withdrawn.id },
        include: summaryInclude,
      });

      if (!stored) {
        throw new AppError(500, 'JOIN_REQUEST_NOT_STORED', 'The join request could not be stored');
      }

      return toSummary(stored);
    },

    async rotateCode(input, ctx): Promise<JoinCodeResult> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ManageJoinRequests,
      });

      if (access.workspace.type === 'INDIVIDUAL') {
        throw new AppError(
          409,
          'WORKSPACE_NOT_JOINABLE',
          'A personal workspace does not support join codes',
        );
      }

      const code = generateSecureToken(24);
      const joinCodeHash = hashSecret(code);

      await client.$transaction(async (tx) => {
        await tx.workspace.update({
          where: { id: access.workspace.id },
          data: { joinCodeHash },
        });

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.JoinCodeRotated,
          targetType: 'Workspace',
          targetId: access.workspace.id,
          metadata: {},
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      });

      const base = config.frontendUrl.replace(/\/+$/, '');

      return {
        workspaceId: access.workspace.id,
        code,
        link: `${base}${config.workspaceJoinLinkPath}?code=${encodeURIComponent(code)}`,
      };
    },

    async disableCode(input, ctx): Promise<{ workspaceId: string; joinCodeEnabled: false }> {
      const access = await requireWorkspaceAccess(client, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ManageJoinRequests,
      });

      await client.$transaction(async (tx) => {
        await tx.workspace.update({
          where: { id: access.workspace.id },
          data: { joinCodeHash: null },
        });

        await recordAuditEvent(tx, {
          workspaceId: access.workspace.id,
          actorId: input.userId,
          action: WorkspaceAuditAction.JoinCodeDisabled,
          targetType: 'Workspace',
          targetId: access.workspace.id,
          metadata: {},
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      });

      return { workspaceId: access.workspace.id, joinCodeEnabled: false };
    },
  };
}
