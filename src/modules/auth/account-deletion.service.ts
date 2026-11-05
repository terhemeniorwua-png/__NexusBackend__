import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '../../utils/logger';
import { hashPassword } from '../../services/password';

export const ACCOUNT_DELETION_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1_000;
const ACCOUNT_DELETION_BATCH_SIZE = 25;
const ACCOUNT_DELETION_POLL_INTERVAL_MS = 60_000;

export function scheduledAccountDeletionAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + ACCOUNT_DELETION_GRACE_PERIOD_MS);
}

export async function isLastActiveOrganizationOwnerOrAdministrator(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<boolean> {
  const administratorMemberships = await tx.workspaceMembership.findMany({
    where: {
      userId,
      status: 'ACTIVE',
      OR: [
        {
          organizationRole: {
            in: ['COMPANY_OWNER', 'COMPANY_ADMIN', 'INSTITUTION_OWNER', 'INSTITUTION_ADMIN'],
          },
        },
        { role: { in: ['OWNER', 'PROJECT_MANAGER'] }, organizationRole: null },
      ],
      workspace: { type: { in: ['COMPANY', 'INSTITUTION'] }, deletedAt: null },
    },
    select: {
      workspace: {
        select: {
          ownerId: true,
          owner: { select: { status: true, deletedAt: true } },
          members: {
            where: {
              userId: { not: userId },
              status: 'ACTIVE',
              OR: [
                { organizationRole: { in: ['COMPANY_OWNER', 'INSTITUTION_OWNER'] } },
                { organizationRole: { in: ['COMPANY_ADMIN', 'INSTITUTION_ADMIN'] } },
                { role: { in: ['OWNER', 'PROJECT_MANAGER'] }, organizationRole: null },
              ],
            },
            select: {
              role: true,
              organizationRole: true,
              user: { select: { status: true, deletedAt: true } },
            },
          },
        },
      },
    },
  });

  return administratorMemberships.some(({ workspace }) => {
    const activeOwner =
      (workspace.ownerId !== userId &&
        workspace.owner.status === 'ACTIVE' &&
        workspace.owner.deletedAt === null) ||
      workspace.members.some(
        ({ user, organizationRole }) =>
          (organizationRole === 'COMPANY_OWNER' || organizationRole === 'INSTITUTION_OWNER') &&
          user.status === 'ACTIVE' &&
          user.deletedAt === null,
      );
    const activeAdministrator = workspace.members.some(
      ({ user, organizationRole, role }) =>
        user.status === 'ACTIVE' &&
        user.deletedAt === null &&
        (organizationRole === 'COMPANY_ADMIN' ||
          organizationRole === 'INSTITUTION_ADMIN' ||
          (!organizationRole && (role === 'PROJECT_MANAGER' || role === 'OWNER'))),
    );

    return !activeOwner && !activeAdministrator;
  });
}

export interface AccountDeletionBatchResult {
  deleted: number;
  blocked: Array<{
    userId: string;
    reason:
      | 'ORGANIZATION_OWNERSHIP'
      | 'LAST_ORGANIZATION_ADMIN'
      | 'PERSONAL_WORKSPACE_SHARED'
      | 'PERSONAL_FILES';
  }>;
}

/**
 * Permanently removes due accounts in an idempotent database transaction.
 * The row lock and state predicate make concurrent server instances safe.
 * Personal workspaces with collaborators or file metadata are held for manual
 * resolution because this repository has no object-storage deletion adapter.
 */
export async function processPendingAccountDeletions(
  prisma: PrismaClient,
  now = new Date(),
  bcryptSaltRounds = 12,
): Promise<AccountDeletionBatchResult> {
  const blocked: AccountDeletionBatchResult['blocked'] = [];

  const dueCount = await prisma.user.count({
    where: {
      status: 'PENDING_DELETION',
      deletedAt: null,
      scheduledDeletionAt: { lte: now },
    },
  });

  if (dueCount === 0) {
    return { deleted: 0, blocked };
  }

  const replacementPasswordHash = await hashPassword(
    randomBytes(48).toString('base64url'),
    bcryptSaltRounds,
  );

  const deleted = await prisma.$transaction(async (tx) => {
    const candidates = await tx.$queryRaw<Array<{ id: string; email: string }>>`
      SELECT "id", "email"
      FROM "User"
      WHERE "status" = 'PENDING_DELETION'
        AND "deletedAt" IS NULL
        AND "scheduledDeletionAt" <= ${now}
      ORDER BY "scheduledDeletionAt", "id"
      LIMIT ${ACCOUNT_DELETION_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `;
    let deletedCount = 0;

    for (const candidate of candidates) {
      const organization = await tx.workspace.findFirst({
        where: {
          ownerId: candidate.id,
          type: { in: ['COMPANY', 'INSTITUTION'] },
        },
        select: { id: true },
      });

      if (organization) {
        blocked.push({ userId: candidate.id, reason: 'ORGANIZATION_OWNERSHIP' });
        continue;
      }

      const otherOwnedWorkspace = await tx.workspace.findFirst({
        where: { ownerId: candidate.id, isPersonal: false },
        select: { id: true },
      });

      if (otherOwnedWorkspace) {
        blocked.push({ userId: candidate.id, reason: 'ORGANIZATION_OWNERSHIP' });
        continue;
      }

      if (await isLastActiveOrganizationOwnerOrAdministrator(tx, candidate.id)) {
        blocked.push({ userId: candidate.id, reason: 'LAST_ORGANIZATION_ADMIN' });
        continue;
      }

      const personalWorkspaces = await tx.workspace.findMany({
        where: { ownerId: candidate.id, isPersonal: true },
        select: {
          id: true,
          _count: { select: { members: true, files: true } },
        },
      });

      if (personalWorkspaces.some((workspace) => workspace._count.members > 1)) {
        blocked.push({ userId: candidate.id, reason: 'PERSONAL_WORKSPACE_SHARED' });
        continue;
      }

      if (personalWorkspaces.some((workspace) => workspace._count.files > 0)) {
        blocked.push({ userId: candidate.id, reason: 'PERSONAL_FILES' });
        continue;
      }

      const deletedAt = now;
      const replacementEmail = `deleted+${candidate.id}@nexus.invalid`;
      // The relational FileAttachment records of a personal workspace cascade
      // with it. We refuse accounts that have any such records until a storage
      // adapter can delete the matching private objects safely.
      if (personalWorkspaces.length > 0) {
        await tx.workspace.deleteMany({
          where: { id: { in: personalWorkspaces.map((workspace) => workspace.id) } },
        });
      }

      await tx.invitation.updateMany({
        where: {
          status: 'PENDING',
          OR: [
            { invitedById: candidate.id },
            { forUserId: candidate.id },
            { email: candidate.email },
          ],
        },
        data: { status: 'REVOKED', revokedAt: deletedAt, pendingKey: null },
      });
      await tx.joinRequest.deleteMany({ where: { userId: candidate.id } });
      await tx.workspaceMembership.deleteMany({ where: { userId: candidate.id } });
      await tx.teamMembership.deleteMany({ where: { userId: candidate.id } });
      await tx.projectMembership.deleteMany({ where: { userId: candidate.id } });
      await tx.departmentMembership.deleteMany({ where: { userId: candidate.id } });
      await tx.institutionGroupMembership.deleteMany({ where: { userId: candidate.id } });
      await tx.institutionGroup.updateMany({
        where: { leadId: candidate.id },
        data: { leadId: null },
      });
      await tx.taskAssignee.deleteMany({ where: { userId: candidate.id } });
      await tx.team.updateMany({ where: { leadId: candidate.id }, data: { leadId: null } });
      await tx.notification.deleteMany({ where: { userId: candidate.id } });
      await tx.authToken.deleteMany({ where: { userId: candidate.id } });
      await tx.session.deleteMany({ where: { userId: candidate.id } });
      await tx.userProfile.deleteMany({ where: { userId: candidate.id } });
      await tx.emailDelivery.deleteMany({ where: { toAddress: candidate.email } });

      await tx.auditLog.updateMany({
        where: {
          OR: [{ actorId: candidate.id }, { targetType: 'User', targetId: candidate.id }],
        },
        data: { metadata: Prisma.DbNull, ip: null, userAgent: null },
      });
      await tx.$executeRaw`
        UPDATE "AuditLog"
        SET "metadata" = NULL
        WHERE "metadata"->>'userId' = ${candidate.id}
           OR "metadata"->>'email' = ${candidate.email}
      `;

      await tx.user.updateMany({
        where: {
          id: candidate.id,
          status: 'PENDING_DELETION',
          deletedAt: null,
          scheduledDeletionAt: { lte: now },
        },
        data: {
          email: replacementEmail,
          name: 'Deleted user',
          passwordHash: replacementPasswordHash,
          status: 'DEACTIVATED',
          deletedAt,
          emailVerifiedAt: null,
          lastLoginAt: null,
        },
      });

      // Keep the neutral user tombstone so shared tasks, comments, project
      // ownership and audit records retain valid foreign keys and attribution.
      await tx.auditLog.create({
        data: {
          action: 'auth.account_deleted',
          targetType: 'User',
          targetId: candidate.id,
          metadata: { completedAt: deletedAt.toISOString() },
        },
      });

      deletedCount += 1;
    }

    return deletedCount;
  });

  return { deleted, blocked };
}

export interface AccountDeletionWorker {
  start(): void;
  stop(): Promise<void>;
}

export function createAccountDeletionWorker(input: {
  prisma: PrismaClient;
  logger: Logger;
  bcryptSaltRounds?: number;
}): AccountDeletionWorker {
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  const loggedBlockedUsers = new Set<string>();

  const run = (): Promise<void> => {
    if (inFlight) {
      return inFlight;
    }

    inFlight = processPendingAccountDeletions(input.prisma, new Date(), input.bcryptSaltRounds)
      .then((result) => {
        if (result.deleted > 0) {
          input.logger.info('account_deletions_completed', { count: result.deleted });
        }

        const currentBlockedUsers = new Set(result.blocked.map((item) => item.userId));

        for (const item of result.blocked) {
          if (!loggedBlockedUsers.has(item.userId)) {
            input.logger.warn('account_deletion_blocked', {
              userId: item.userId,
              reason: item.reason,
            });
          }

          loggedBlockedUsers.add(item.userId);
        }

        for (const userId of loggedBlockedUsers) {
          if (!currentBlockedUsers.has(userId)) {
            loggedBlockedUsers.delete(userId);
          }
        }
      })
      .catch((error: unknown) => {
        input.logger.error('account_deletion_worker_failed', { error });
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };

  return {
    start(): void {
      if (timer) {
        return;
      }

      void run();
      timer = setInterval(() => void run(), ACCOUNT_DELETION_POLL_INTERVAL_MS);
      timer.unref();
    },
    async stop(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }

      if (inFlight) {
        await inFlight;
      }
    },
  };
}
