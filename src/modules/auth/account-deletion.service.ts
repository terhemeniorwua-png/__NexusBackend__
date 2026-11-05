import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { Logger } from '../../utils/logger';
import { hashPassword } from '../../services/password';
import type { PrivateObjectStorage } from '../../services/storage/private-object-storage';
import { isAppError } from '../../utils/errors';

const ACCOUNT_DELETION_BATCH_SIZE = 25;
const ACCOUNT_DELETION_POLL_INTERVAL_MS = 60_000;
export const ACCOUNT_DELETION_GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1_000;

export function scheduledAccountDeletionAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + ACCOUNT_DELETION_GRACE_PERIOD_MS);
}

export interface AccountDeletionBatchResult {
  deleted: number;
  blocked: Array<{
    userId: string;
    reason: 'FINALIZATION_FAILED' | 'STORAGE_UNAVAILABLE' | 'STORAGE_FAILED' | 'OBJECT_MISSING';
  }>;
}

/**
 * Permanently removes due accounts in an idempotent database transaction.
 * The row lock and state predicate make concurrent server instances safe.
 * Collaboration records and workspaces are retained. A neutral user tombstone
 * preserves foreign keys while removing the deleted person's profile identity.
 */
export async function processPendingAccountDeletions(
  prisma: PrismaClient,
  now = new Date(),
  bcryptSaltRounds = 12,
  storage?: PrivateObjectStorage,
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

  // Storage mutations and classification run after acquiring the account row
  // lock. Idempotent object DELETE lets a later retry repair a DB rollback.
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
      await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Workspace"
        WHERE "ownerId" = ${candidate.id} AND "isPersonal" = true
        FOR UPDATE`;
      const attachments = await tx.fileAttachment.findMany({
        where: {
          uploadedById: candidate.id,
          workspace: { isPersonal: true, ownerId: candidate.id },
        },
        include: {
          workspace: {
            select: {
              ownerId: true,
              isPersonal: true,
              members: { select: { userId: true } },
            },
          },
          project: {
            select: {
              ownerId: true,
              workspaceId: true,
              members: { select: { userId: true } },
              tasks: { select: { creatorId: true, assignees: { select: { userId: true } }, comments: { select: { id: true } } } },
            },
          },
          task: {
            select: {
              creatorId: true,
              assignees: { select: { userId: true } },
              comments: { select: { id: true } },
              project: {
                select: {
                  ownerId: true,
                  workspaceId: true,
                  members: { select: { userId: true } },
                  tasks: { select: { creatorId: true, assignees: { select: { userId: true } }, comments: { select: { id: true } } } },
                },
              },
            },
          },
          comment: { select: { id: true } },
        },
      });
      let storageFailed = false;
      let storageFailureReason: AccountDeletionBatchResult['blocked'][number]['reason'] =
        'STORAGE_FAILED';

      for (const attachment of attachments) {
        const task = attachment.task;
        const project = attachment.project ?? task?.project;
        const shared =
          attachment.uploadedById !== candidate.id ||
          !attachment.workspace.isPersonal ||
          attachment.workspace.ownerId !== candidate.id ||
          attachment.workspace.members.some((member) => member.userId !== candidate.id) ||
          Boolean(project && project.workspaceId !== attachment.workspaceId) ||
          Boolean(attachment.comment) ||
          Boolean(
            project &&
              (project.ownerId !== candidate.id ||
                project.members.some((member) => member.userId !== candidate.id) ||
                project.tasks.some((relatedTask) =>
                  relatedTask.creatorId !== candidate.id ||
                  relatedTask.assignees.some((assignee) => assignee.userId !== candidate.id) ||
                  relatedTask.comments.length > 0,
                )),
          ) ||
          Boolean(
            task &&
              (task.creatorId !== candidate.id ||
                task.assignees.some((assignee) => assignee.userId !== candidate.id) ||
                task.comments.length > 0),
          );

        let outcome: 'DELETED' | 'RETAINED_SHARED' | 'FAILED' | 'UNAVAILABLE';
        if (shared) {
          outcome = 'RETAINED_SHARED';
        } else if (!storage) {
          outcome = 'UNAVAILABLE';
          storageFailed = true;
          storageFailureReason = 'STORAGE_UNAVAILABLE';
        } else {
          try {
            await storage.delete(attachment.storageKey);
            await tx.fileAttachment.delete({ where: { id: attachment.id } });
            outcome = 'DELETED';
          } catch (error: unknown) {
            outcome = isAppError(error) && error.code === 'OBJECT_STORAGE_UNAVAILABLE'
              ? 'UNAVAILABLE'
              : 'FAILED';
            storageFailed = true;
            storageFailureReason =
              outcome === 'UNAVAILABLE' ? 'STORAGE_UNAVAILABLE' : 'STORAGE_FAILED';
          }
        }

        await tx.auditLog.create({
          data: {
            workspaceId: attachment.workspaceId,
            action:
              outcome === 'DELETED'
                ? 'auth.account_deletion_file_deleted'
                : outcome === 'RETAINED_SHARED'
                  ? 'auth.account_deletion_file_retained'
                  : 'auth.account_deletion_file_deletion_failed',
            targetType: 'FileAttachment',
            targetId: attachment.id,
            metadata: { outcome },
          },
        });
      }
      if (storageFailed) {
        blocked.push({ userId: candidate.id, reason: storageFailureReason });
        continue;
      }
      const deletedAt = now;
      const replacementEmail = `deleted+${candidate.id}@nexus.invalid`;

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
      await tx.institutionGroup.updateMany({
        where: { leadId: candidate.id },
        data: { leadId: null },
      });
      // Keep membership, assignment, comments, shared files, projects and workspaces:
      // their retained records become attributable to the Deleted user tombstone.
      await tx.team.updateMany({ where: { leadId: candidate.id }, data: { leadId: null } });
      await tx.notification.deleteMany({ where: { userId: candidate.id } });
      await tx.authToken.deleteMany({ where: { userId: candidate.id } });
      await tx.session.deleteMany({ where: { userId: candidate.id } });
      await tx.userProfile.deleteMany({ where: { userId: candidate.id } });
      await tx.emailDelivery.deleteMany({ where: { toAddress: candidate.email } });
      await tx.workspace.updateMany({
        where: { ownerId: candidate.id },
        data: { status: 'SUSPENDED' },
      });

      await tx.auditLog.updateMany({
        where: {
          OR: [{ actorId: candidate.id }, { targetType: 'User', targetId: candidate.id }],
        },
        data: { actorId: null, metadata: Prisma.DbNull, ip: null, userAgent: null },
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
  storage?: PrivateObjectStorage;
}): AccountDeletionWorker {
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> | null = null;
  const loggedBlockedUsers = new Set<string>();

  const run = (): Promise<void> => {
    if (inFlight) {
      return inFlight;
    }

    inFlight = processPendingAccountDeletions(
      input.prisma,
      new Date(),
      input.bcryptSaltRounds,
      input.storage,
    )
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
