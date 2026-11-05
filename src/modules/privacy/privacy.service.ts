import {
  Prisma,
  type PrismaClient,
  type PrivacyRequestStatus,
  type PrivacyRequestType,
} from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { AppError } from '../../utils/errors';
import { requireProjectAccess, ProjectCapability } from '../authorization/project.policy';
import { requireWorkspaceAccess, WorkspaceCapability } from '../authorization/workspace.policy';

export interface PrivacyRequestInput {
  type: PrivacyRequestType;
  description?: string;
  targetType?: string;
  targetId?: string;
}

export interface PrivacyListInput {
  limit: number;
  cursor?: string;
  status?: PrivacyRequestStatus;
}

export interface PrivacyService {
  create(input: { userId: string; request: PrivacyRequestInput }): Promise<unknown>;
  getMine(input: { userId: string; requestId: string }): Promise<unknown>;
  listMine(input: { userId: string; query: PrivacyListInput }): Promise<unknown>;
  listForReview(input: { actorId: string; query: PrivacyListInput }): Promise<unknown>;
  beginReview(input: { actorId: string; requestId: string }): Promise<unknown>;
  decide(input: {
    actorId: string;
    requestId: string;
    decision: 'APPROVE' | 'REJECT';
    note?: string;
  }): Promise<unknown>;
  complete(input: { actorId: string; requestId: string; outcome: string }): Promise<unknown>;
  redactComment(input: {
    actorId: string;
    requestId: string;
    matchText: string;
    replacementText: string;
  }): Promise<unknown>;
}

export function createPrivacyService(client: PrismaClient = getPrismaClient()): PrivacyService {
  async function requireReviewer(
    tx: PrismaClient | Prisma.TransactionClient,
    actorId: string,
  ): Promise<void> {
    const actor = await tx.user.findUnique({
      where: { id: actorId },
      select: { isPlatformAdmin: true, status: true, deletedAt: true },
    });
    if (!actor?.isPlatformAdmin || actor.status !== 'ACTIVE' || actor.deletedAt) {
      throw new AppError(
        403,
        'PRIVACY_REVIEWER_REQUIRED',
        'An authorized privacy reviewer is required',
      );
    }
  }

  return {
    async create({ userId, request }) {
      const user = await client.user.findUnique({
        where: { id: userId },
        select: { status: true, deletedAt: true, emailVerifiedAt: true },
      });
      if (!user || user.status !== 'ACTIVE' || user.deletedAt || !user.emailVerifiedAt) {
        throw new AppError(
          403,
          'IDENTITY_VERIFICATION_REQUIRED',
          'A verified active account is required',
        );
      }
      if (request.type === 'REDACTION') {
        if (request.targetType !== 'COMMENT' || !request.targetId) {
          throw new AppError(
            400,
            'INVALID_REDACTION_TARGET',
            'Redaction requests must target a comment',
          );
        }
        const target = await client.comment.findUnique({
          where: { id: request.targetId },
          select: {
            id: true,
            authorId: true,
            task: { select: { projectId: true, project: { select: { workspaceId: true } } } },
          },
        });
        if (!target)
          throw new AppError(
            404,
            'PRIVACY_TARGET_NOT_FOUND',
            'The requested content was not found',
          );
        const access = await requireWorkspaceAccess(client, {
          userId,
          workspaceId: target.task.project.workspaceId,
          capability: WorkspaceCapability.ViewWorkspace,
        });
        if (target.authorId !== userId) {
          await requireProjectAccess(client, {
            userId,
            workspaceId: target.task.project.workspaceId,
            projectId: target.task.projectId,
            workspaceRole: access.effectiveRole,
            capability: ProjectCapability.ViewTasks,
          });
        }
      }
      const created = await client.$transaction(async (tx) => {
        const row = await tx.privacyRequest.create({ data: { userId, ...request } });
        await recordAuditEvent(tx, {
          actorId: userId,
          action: 'privacy.request_submitted',
          targetType: 'PrivacyRequest',
          targetId: row.id,
          metadata: { type: row.type },
        });
        return row;
      });
      return created;
    },

    async listMine({ userId, query }) {
      return client.privacyRequest.findMany({
        where: { userId, ...(query.status ? { status: query.status } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });
    },

    async getMine({ userId, requestId }) {
      const request = await client.privacyRequest.findFirst({ where: { id: requestId, userId } });
      if (!request)
        throw new AppError(404, 'PRIVACY_REQUEST_NOT_FOUND', 'The privacy request was not found');
      return request;
    },

    async listForReview({ actorId, query }) {
      await requireReviewer(client, actorId);
      return client.privacyRequest.findMany({
        where: { ...(query.status ? { status: query.status } : {}) },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: query.limit,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });
    },

    async beginReview({ actorId, requestId }) {
      return client.$transaction(async (tx) => {
        await requireReviewer(tx, actorId);
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "PrivacyRequest" WHERE "id" = ${requestId} FOR UPDATE`;
        if (!locked)
          throw new AppError(404, 'PRIVACY_REQUEST_NOT_FOUND', 'The privacy request was not found');
        const request = await tx.privacyRequest.findUniqueOrThrow({ where: { id: requestId } });
        if (request.status !== 'SUBMITTED') {
          throw new AppError(
            409,
            'PRIVACY_REQUEST_ALREADY_CLAIMED',
            'The privacy request is no longer available for review',
          );
        }
        const updated = await tx.privacyRequest.update({
          where: { id: requestId },
          data: { status: 'IN_REVIEW', reviewedById: actorId },
        });
        await recordAuditEvent(tx, {
          actorId,
          action: 'privacy.request_review_started',
          targetType: 'PrivacyRequest',
          targetId: requestId,
          metadata: { type: request.type },
        });
        return updated;
      });
    },

    async decide({ actorId, requestId, decision, note }) {
      return client.$transaction(async (tx) => {
        await requireReviewer(tx, actorId);
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "PrivacyRequest" WHERE "id" = ${requestId} FOR UPDATE`;
        if (!locked)
          throw new AppError(404, 'PRIVACY_REQUEST_NOT_FOUND', 'The privacy request was not found');
        const request = await tx.privacyRequest.findUniqueOrThrow({ where: { id: requestId } });
        if (request.status !== 'SUBMITTED' && request.status !== 'IN_REVIEW') {
          throw new AppError(
            409,
            'PRIVACY_REQUEST_ALREADY_DECIDED',
            'The privacy request is already decided',
          );
        }
        const status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
        const updated = await tx.privacyRequest.update({
          where: { id: requestId },
          data: {
            status,
            reviewedById: actorId,
            decisionNote: note ?? null,
            decidedAt: new Date(),
          },
        });
        await recordAuditEvent(tx, {
          actorId,
          action: decision === 'APPROVE' ? 'privacy.request_approved' : 'privacy.request_rejected',
          targetType: 'PrivacyRequest',
          targetId: requestId,
          metadata: { type: request.type },
        });
        return updated;
      });
    },

    async complete({ actorId, requestId, outcome }) {
      return client.$transaction(async (tx) => {
        await requireReviewer(tx, actorId);
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "PrivacyRequest" WHERE "id" = ${requestId} FOR UPDATE`;
        if (!locked)
          throw new AppError(404, 'PRIVACY_REQUEST_NOT_FOUND', 'The privacy request was not found');
        const request = await tx.privacyRequest.findUniqueOrThrow({ where: { id: requestId } });
        if (request.status !== 'APPROVED' || request.type === 'REDACTION') {
          throw new AppError(
            409,
            'PRIVACY_REQUEST_NOT_READY',
            'This approved request cannot be completed through this operation',
          );
        }
        const updated = await tx.privacyRequest.update({
          where: { id: requestId },
          data: { status: 'COMPLETED', outcome, completedAt: new Date(), reviewedById: actorId },
        });
        await recordAuditEvent(tx, {
          actorId,
          action: 'privacy.request_completed',
          targetType: 'PrivacyRequest',
          targetId: requestId,
          metadata: { type: request.type },
        });
        return updated;
      });
    },

    async redactComment({ actorId, requestId, matchText, replacementText }) {
      return client.$transaction(async (tx) => {
        await requireReviewer(tx, actorId);
        const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "PrivacyRequest" WHERE "id" = ${requestId} FOR UPDATE`;
        if (!locked)
          throw new AppError(404, 'PRIVACY_REQUEST_NOT_FOUND', 'The privacy request was not found');
        const request = await tx.privacyRequest.findUniqueOrThrow({ where: { id: requestId } });
        if (
          request.status !== 'APPROVED' ||
          request.type !== 'REDACTION' ||
          request.targetType !== 'COMMENT' ||
          !request.targetId
        ) {
          throw new AppError(
            409,
            'PRIVACY_REDACTION_NOT_APPROVED',
            'An approved comment redaction request is required',
          );
        }
        const [lockedComment] = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Comment" WHERE "id" = ${request.targetId} FOR UPDATE`;
        if (!lockedComment)
          throw new AppError(
            404,
            'PRIVACY_TARGET_NOT_FOUND',
            'The requested comment was not found',
          );
        const comment = await tx.comment.findUnique({
          where: { id: request.targetId },
          include: { task: { include: { project: { select: { workspaceId: true } } } } },
        });
        if (!comment)
          throw new AppError(
            404,
            'PRIVACY_TARGET_NOT_FOUND',
            'The requested comment was not found',
          );
        const occurrences = comment.body.split(matchText).length - 1;
        if (occurrences === 0)
          throw new AppError(
            409,
            'REDACTION_TEXT_NOT_FOUND',
            'The selected text is no longer present',
          );
        const body = comment.body.split(matchText).join(replacementText);
        if (body.length > 20_000)
          throw new AppError(
            400,
            'REDACTION_RESULT_TOO_LONG',
            'The redacted comment exceeds the supported length',
          );
        await tx.comment.update({
          where: { id: comment.id },
          data: { body, editedAt: new Date() },
        });
        const updated = await tx.privacyRequest.update({
          where: { id: requestId },
          data: {
            status: 'COMPLETED',
            reviewedById: actorId,
            completedAt: new Date(),
            outcome: 'Approved personal text was replaced in the requested comment.',
          },
        });
        await recordAuditEvent(tx, {
          workspaceId: comment.task.project.workspaceId,
          actorId,
          action: 'privacy.comment_redacted',
          targetType: 'Comment',
          targetId: comment.id,
          metadata: { privacyRequestId: requestId, replacedOccurrences: occurrences },
        });
        await recordAuditEvent(tx, {
          actorId,
          action: 'privacy.request_completed',
          targetType: 'PrivacyRequest',
          targetId: requestId,
          metadata: { type: request.type },
        });
        return updated;
      });
    },
  };
}
