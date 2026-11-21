import {
  Prisma,
  type PrismaClient,
  type ReviewDecision,
  type ReviewDecisionType,
  type ReviewStatus,
} from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent, ReviewAuditAction } from '../../services/audit';
import { AppError } from '../../utils/errors';
import {
  ProjectPermission,
  authorizeProject,
  getProjectAuthorization,
  projectRoleHasPermission,
  type ProjectActor,
  type ProjectAuthorization,
  type ProjectAuthorizationResource,
  type ProjectPermissionValue,
} from '../authorization';
import { assertProjectWritable } from '../projects/project-archive';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { assertReviewTransition, isOpenReviewStatus } from './review-status';

const reviewInclude = {
  decisions: { orderBy: { round: 'desc' }, take: 1 },
  checklist: {
    select: {
      id: true,
      workspaceId: true,
      projectId: true,
      revision: true,
      deletedAt: true,
    },
  },
  attachmentVersion: {
    select: {
      id: true,
      deletedAt: true,
      attachment: {
        select: {
          workspaceId: true,
          projectId: true,
          deletedAt: true,
        },
      },
    },
  },
} satisfies Prisma.ReviewInclude;

type DbClient = PrismaClient | Prisma.TransactionClient;
type ReviewRow = Prisma.ReviewGetPayload<{ include: typeof reviewInclude }>;

type Input = { userId: string; workspaceId: string; projectId: string };
type Target =
  | { kind: 'attachmentVersion'; id: string }
  | { kind: 'checklist'; id: string };

export interface ReviewResourceView {
  kind: 'attachmentVersion' | 'checklist';
  id: string;
  revision?: number;
}

export interface ReviewDecisionView {
  id: string;
  reviewId: string;
  round: number;
  decision: ReviewDecision['decision'];
  note: string | null;
  decidedById: string;
  decidedAt: string;
}

export interface ReviewView {
  id: string;
  workspaceId: string;
  projectId: string;
  resource: ReviewResourceView;
  status: ReviewStatus;
  round: number;
  assigneeId: string | null;
  submittedById: string;
  submittedAt: string;
  checklistRevision: number | null;
  lastDecision: ReviewDecisionView | null;
  stale: boolean;
  createdAt: string;
  updatedAt: string;
}

type SubmissionAction = Extract<ProjectAuthorizationResource, { kind: 'submission' }>['action'];

function submissionResource(
  submissionId: string,
  subjectUserId: string,
  action: SubmissionAction,
): ProjectAuthorizationResource {
  return { kind: 'submission', submissionId, subjectUserId, action };
}

function toDecisionView(decision: ReviewDecision): ReviewDecisionView {
  return {
    id: decision.id,
    reviewId: decision.reviewId,
    round: decision.round,
    decision: decision.decision,
    note: decision.note,
    decidedById: decision.decidedById,
    decidedAt: decision.decidedAt.toISOString(),
  };
}

function assertDecisionNote(decision: ReviewDecisionType, note?: string): void {
  if (decision === 'APPROVED') {
    if (note === undefined) return;
    if (note.length < 1 || note.length > 2000 || note.trim().length === 0) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Decision note must be between 1 and 2000 non-blank characters',
      );
    }
    return;
  }

  if (note === undefined || note.length < 1 || note.length > 2000 || note.trim().length === 0) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'A note between 1 and 2000 non-blank characters is required for this decision',
    );
  }
}

function targetStatusForDecision(decision: ReviewDecisionType): ReviewStatus {
  return decision === 'APPROVED' ? 'APPROVED' : 'CHANGES_REQUESTED';
}

function permissionForDecision(decision: ReviewDecisionType): ProjectPermissionValue {
  switch (decision) {
    case 'APPROVED':
      return ProjectPermission.SubmissionApprove;
    case 'REJECTED':
      return ProjectPermission.SubmissionReject;
    case 'CHANGES_REQUESTED':
      return ProjectPermission.SubmissionRequestRevision;
  }
}

function submissionActionForDecision(
  decision: ReviewDecisionType,
): 'approve' | 'reject' | 'request_revision' {
  if (decision === 'APPROVED') return 'approve';
  if (decision === 'REJECTED') return 'reject';
  return 'request_revision';
}

function auditActionForDecision(decision: ReviewDecisionType): string {
  switch (decision) {
    case 'APPROVED':
      return ReviewAuditAction.ReviewApproved;
    case 'REJECTED':
      return ReviewAuditAction.ReviewRejected;
    case 'CHANGES_REQUESTED':
      return ReviewAuditAction.ReviewChangesRequested;
  }
}

function reviewAudit(
  input: Input,
  reviewId: string,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  return {
    workspaceId: input.workspaceId,
    actorId: input.userId,
    action,
    targetType: 'Review',
    targetId: reviewId,
    metadata: { projectId: input.projectId, ...metadata },
  };
}

function toReviewView(row: ReviewRow): ReviewView {
  if (row.checklistId) {
    if (row.checklistRevision === null) {
      throw new AppError(500, 'REVIEW_TARGET_INVALID', 'Checklist review is missing its revision');
    }
    const stale = !row.checklist || row.checklist.deletedAt !== null
      ? true
      : row.checklist.revision !== row.checklistRevision;
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      resource: {
        kind: 'checklist',
        id: row.checklistId,
        revision: row.checklistRevision,
      },
      status: row.status,
      round: row.round,
      assigneeId: row.assigneeId,
      submittedById: row.submittedById,
      submittedAt: row.submittedAt.toISOString(),
      checklistRevision: row.checklistRevision,
      lastDecision: row.decisions[0] ? toDecisionView(row.decisions[0]) : null,
      stale,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  if (!row.attachmentVersionId) {
    throw new AppError(500, 'REVIEW_TARGET_INVALID', 'Review is missing a typed target');
  }

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    resource: { kind: 'attachmentVersion', id: row.attachmentVersionId },
    status: row.status,
    round: row.round,
    assigneeId: row.assigneeId,
    submittedById: row.submittedById,
    submittedAt: row.submittedAt.toISOString(),
    checklistRevision: null,
    lastDecision: row.decisions[0] ? toDecisionView(row.decisions[0]) : null,
    stale: false,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createReviewService(prisma: PrismaClient = getPrismaClient()) {
  async function loadProjectContext(
    input: Input,
    mode: 'view' | 'write',
  ): Promise<{ actor: ProjectActor; authorization: ProjectAuthorization }> {
    const workspace = await requireWorkspaceAccess(prisma, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      capability: WorkspaceCapability.ViewWorkspace,
    });
    const actor = {
      userId: input.userId,
      workspaceId: input.workspaceId,
      workspaceRole: workspace.effectiveRole,
    };
    const authorization = await getProjectAuthorization(prisma, actor, input.projectId);
    if (mode === 'write') assertProjectWritable(authorization.project);
    return { actor, authorization };
  }

  async function findReviewRow(
    client: DbClient,
    input: Input & { reviewId: string },
  ): Promise<ReviewRow | null> {
    return client.review.findFirst({
      where: {
        id: input.reviewId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
      include: reviewInclude,
    });
  }

  function assertTargetVisible(row: ReviewRow, input: Input): void {
    if (row.checklistId) {
      const checklist = row.checklist;
      if (
        !checklist ||
        checklist.deletedAt !== null ||
        checklist.workspaceId !== input.workspaceId ||
        checklist.projectId !== input.projectId
      ) {
        throw new AppError(404, 'REVIEW_TARGET_NOT_FOUND', 'That review target does not exist');
      }
      return;
    }

    const version = row.attachmentVersion;
    if (
      !row.attachmentVersionId ||
      !version ||
      version.deletedAt !== null ||
      version.attachment.deletedAt !== null ||
      version.attachment.workspaceId !== input.workspaceId ||
      version.attachment.projectId !== input.projectId
    ) {
      throw new AppError(404, 'REVIEW_TARGET_NOT_FOUND', 'That review target does not exist');
    }
  }

  async function resolveTarget(input: Input, target: Target): Promise<Target> {
    if (target.kind === 'attachmentVersion') {
      const version = await prisma.attachmentVersion.findFirst({
        where: {
          id: target.id,
          deletedAt: null,
          attachment: {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            deletedAt: null,
          },
        },
        select: { id: true },
      });
      if (!version) {
        throw new AppError(404, 'REVIEW_TARGET_NOT_FOUND', 'That review target does not exist');
      }
      return { kind: 'attachmentVersion', id: version.id };
    }

    const checklist = await prisma.checklist.findFirst({
      where: {
        id: target.id,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!checklist) {
      throw new AppError(404, 'REVIEW_TARGET_NOT_FOUND', 'That review target does not exist');
    }
    return { kind: 'checklist', id: checklist.id };
  }

  async function assertAssignee(
    input: Input,
    authorization: ProjectAuthorization,
    assigneeId: string,
    submittedById: string = input.userId,
  ) {
    if (assigneeId === submittedById) {
      throw new AppError(
        403,
        'SELF_REVIEW_FORBIDDEN',
        'The assignee cannot review their own submission',
      );
    }

    const membership = await prisma.projectMembership.findUnique({
      where: { projectId_userId: { projectId: input.projectId, userId: assigneeId } },
      select: { role: true },
    });
    const role =
      membership?.role ?? (authorization.project.ownerId === assigneeId ? 'PROJECT_MANAGER' : null);
    if (!role || !projectRoleHasPermission(role, ProjectPermission.SubmissionReview)) {
      throw new AppError(
        403,
        'PERMISSION_DENIED',
        'The assignee must be a project member who can review submissions',
        { requiredPermission: ProjectPermission.SubmissionReview },
      );
    }
  }

  async function assertChecklistReady(
    tx: Prisma.TransactionClient,
    checklistId: string,
  ): Promise<void> {
    const [total, incomplete] = await Promise.all([
      tx.checklistItem.count({ where: { checklistId, deletedAt: null } }),
      tx.checklistItem.count({ where: { checklistId, deletedAt: null, completed: false } }),
    ]);
    if (total === 0 || incomplete > 0) {
      throw new AppError(
        409,
        'CHECKLIST_NOT_READY',
        'A checklist must have at least one live item and all live items completed',
      );
    }
  }

  async function assertNoApprovedTarget(
    tx: Prisma.TransactionClient,
    target: Target,
    checklistRevision: number | null,
  ): Promise<void> {
    const existing = await tx.review.findFirst({
      where:
        target.kind === 'checklist'
          ? {
              checklistId: target.id,
              checklistRevision: checklistRevision ?? undefined,
              status: 'APPROVED',
            }
          : { attachmentVersionId: target.id, status: 'APPROVED' },
      select: { id: true },
    });
    if (existing) {
      throw new AppError(
        409,
        'REVIEW_ALREADY_APPROVED',
        'This submission target already has an approved review',
      );
    }
  }

  async function getRequiredReviewRow(
    client: DbClient,
    input: Input & { reviewId: string },
  ): Promise<ReviewRow> {
    const row = await findReviewRow(client, input);
    if (!row) {
      throw new AppError(404, 'REVIEW_NOT_FOUND', 'That review does not exist');
    }
    assertTargetVisible(row, input);
    return row;
  }

  async function lockReview(tx: Prisma.TransactionClient, reviewId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "Review" WHERE "id" = ${reviewId} FOR UPDATE`;
  }

  /**
   * Decisions and resubmissions must observe the same checklist revision that
   * is attached to the review. A later item write advances Checklist.revision,
   * which makes the old review stale.
   */
  async function assertChecklistRevisionCurrent(
    tx: Prisma.TransactionClient,
    row: ReviewRow,
  ): Promise<void> {
    if (!row.checklistId) return;
    if (row.checklistRevision === null) {
      throw new AppError(500, 'REVIEW_TARGET_INVALID', 'Checklist review is missing its revision');
    }

    const locked = await tx.$queryRaw<
      Array<{ revision: number; deletedAt: Date | null }>
    >`SELECT "revision", "deletedAt" FROM "Checklist" WHERE "id" = ${row.checklistId} FOR SHARE`;
    const current = locked[0];
    if (
      !current ||
      current.deletedAt !== null ||
      current.revision !== row.checklistRevision
    ) {
      throw new AppError(
        409,
        'CHECKLIST_REVISION_STALE',
        'The checklist has changed since this review was submitted',
        { details: { expected: row.checklistRevision, actual: current?.revision ?? null } },
      );
    }
  }

  async function decide(
    input: Input & { reviewId: string; round: number; note?: string },
    decision: ReviewDecisionType,
  ) {
    assertDecisionNote(decision, input.note);
    const { actor } = await loadProjectContext(input, 'write');
    const current = await getRequiredReviewRow(prisma, input);
    await authorizeProject(prisma, {
      actor,
      projectId: input.projectId,
      permission: permissionForDecision(decision),
      resource: submissionResource(
        current.id,
        current.submittedById,
        submissionActionForDecision(decision),
      ),
    });

    return prisma.$transaction(async (tx) => {
      await lockReview(tx, input.reviewId);
      const row = await getRequiredReviewRow(tx, input);

      if (row.round !== input.round) {
        throw new AppError(409, 'STALE_ROUND', 'The review round has changed', {
          details: { expected: input.round, actual: row.round },
        });
      }

      await assertChecklistRevisionCurrent(tx, row);

      const nextStatus = targetStatusForDecision(decision);
      assertReviewTransition(row.status, nextStatus, row.round);

      const result = await tx.review.updateMany({
        where: {
          id: input.reviewId,
          round: input.round,
          status: { in: ['SUBMITTED', 'UNDER_REVIEW'] },
        },
        data: { status: nextStatus },
      });
      if (result.count === 0) {
        throw new AppError(409, 'REVIEW_ALREADY_DECIDED', 'This review round was already decided', {
          details: { round: input.round },
        });
      }

      let createdDecision;
      try {
        createdDecision = await tx.reviewDecision.create({
          data: {
            reviewId: input.reviewId,
            round: input.round,
            decision,
            note: input.note ?? null,
            decidedById: input.userId,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new AppError(
            409,
            'REVIEW_ALREADY_DECIDED',
            'This review round was already decided',
            { details: { round: input.round } },
          );
        }
        throw error;
      }

      await recordAuditEvent(
        tx,
        reviewAudit(input, input.reviewId, auditActionForDecision(decision), {
          round: input.round,
          decision,
        }),
      );

      const updated = await getRequiredReviewRow(tx, input);
      return { review: toReviewView(updated), decision: toDecisionView(createdDecision) };
    });
  }

  return {
    async create(
      input: Input & {
        attachmentVersionId?: string;
        checklistId?: string;
        assigneeId?: string;
      },
    ) {
      const target: Target = input.attachmentVersionId
        ? { kind: 'attachmentVersion', id: input.attachmentVersionId }
        : { kind: 'checklist', id: input.checklistId as string };
      const { actor, authorization } = await loadProjectContext(input, 'write');
      const scopedTarget = await resolveTarget(input, target);
      await authorizeProject(prisma, {
        actor,
        projectId: input.projectId,
        permission: ProjectPermission.SubmissionSubmit,
        resource: submissionResource(scopedTarget.id, input.userId, 'submit'),
      });
      if (input.assigneeId) {
        await assertAssignee(input, authorization, input.assigneeId);
      }

      return prisma.$transaction(async (tx) => {
        let checklistRevision: number | null = null;

        if (scopedTarget.kind === 'checklist') {
          await tx.$queryRaw`SELECT "id" FROM "Checklist" WHERE "id" = ${scopedTarget.id} FOR SHARE`;
          const checklist = await tx.checklist.findFirst({
            where: {
              id: scopedTarget.id,
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              deletedAt: null,
            },
            select: { revision: true },
          });
          if (!checklist) {
            throw new AppError(404, 'REVIEW_TARGET_NOT_FOUND', 'That review target does not exist');
          }
          checklistRevision = checklist.revision;
          await assertChecklistReady(tx, scopedTarget.id);
        } else {
          const version = await tx.attachmentVersion.findFirst({
            where: {
              id: scopedTarget.id,
              deletedAt: null,
              attachment: {
                workspaceId: input.workspaceId,
                projectId: input.projectId,
                deletedAt: null,
              },
            },
            select: { id: true },
          });
          if (!version) {
            throw new AppError(404, 'REVIEW_TARGET_NOT_FOUND', 'That review target does not exist');
          }
        }

        await assertNoApprovedTarget(tx, scopedTarget, checklistRevision);

        let created;
        try {
          created = await tx.review.create({
            data: {
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              attachmentVersionId:
                scopedTarget.kind === 'attachmentVersion' ? scopedTarget.id : null,
              checklistId: scopedTarget.kind === 'checklist' ? scopedTarget.id : null,
              checklistRevision,
              submittedById: input.userId,
              assigneeId: input.assigneeId ?? null,
              status: 'SUBMITTED',
              round: 1,
            },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw new AppError(
              409,
              'REVIEW_ALREADY_OPEN',
              'This submission target already has an open review',
            );
          }
          throw error;
        }

        await recordAuditEvent(
          tx,
          reviewAudit(input, created.id, ReviewAuditAction.ReviewCreated, {
            targetKind: scopedTarget.kind,
            targetId: scopedTarget.id,
            round: 1,
          }),
        );

        const row = await getRequiredReviewRow(tx, { ...input, reviewId: created.id });
        return { review: toReviewView(row) };
      });
    },

    async list(
      input: Input & {
        targetKind?: 'attachmentVersion' | 'checklist';
        targetId?: string;
        status?: ReviewStatus;
        assigneeId?: string;
        cursor?: string;
        limit: number;
      },
    ) {
      const { actor } = await loadProjectContext(input, 'view');
      await authorizeProject(prisma, {
        actor,
        projectId: input.projectId,
        permission: ProjectPermission.View,
      });

      const where: Prisma.ReviewWhereInput = {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
        ...(input.targetKind === 'attachmentVersion'
          ? { attachmentVersionId: input.targetId ?? undefined }
          : {}),
        ...(input.targetKind === 'checklist' ? { checklistId: input.targetId ?? undefined } : {}),
        OR: [
          {
            attachmentVersion: {
              deletedAt: null,
              attachment: {
                workspaceId: input.workspaceId,
                projectId: input.projectId,
                deletedAt: null,
              },
            },
          },
          {
            checklist: {
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              deletedAt: null,
            },
          },
        ],
      };

      const rows = await prisma.review.findMany({
        where,
        include: reviewInclude,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = rows.length > input.limit;
      const items = rows.slice(0, input.limit).map(toReviewView);
      return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
    },

    async get(input: Input & { reviewId: string }) {
      const { actor } = await loadProjectContext(input, 'view');
      const row = await getRequiredReviewRow(prisma, input);
      await authorizeProject(prisma, {
        actor,
        projectId: input.projectId,
        permission: ProjectPermission.View,
      });
      return { review: toReviewView(row) };
    },

    async assign(input: Input & { reviewId: string; assigneeId: string }) {
      const { actor, authorization } = await loadProjectContext(input, 'write');
      const current = await getRequiredReviewRow(prisma, input);
      await authorizeProject(prisma, {
        actor,
        projectId: input.projectId,
        permission: ProjectPermission.SubmissionReview,
        resource: submissionResource(current.id, current.submittedById, 'review'),
      });
      await assertAssignee(input, authorization, input.assigneeId, current.submittedById);

      return prisma.$transaction(async (tx) => {
        await lockReview(tx, input.reviewId);
        const row = await getRequiredReviewRow(tx, input);
        if (row.assigneeId === input.assigneeId) {
          return { review: toReviewView(row) };
        }
        if (!isOpenReviewStatus(row.status)) {
          throw new AppError(409, 'REVIEW_NOT_OPEN', 'Only open reviews can be assigned');
        }

        const result = await tx.review.updateMany({
          where: {
            id: input.reviewId,
            status: { in: ['SUBMITTED', 'UNDER_REVIEW'] },
          },
          data: { assigneeId: input.assigneeId },
        });
        if (result.count === 0) {
          throw new AppError(409, 'REVIEW_NOT_OPEN', 'Only open reviews can be assigned');
        }

        await recordAuditEvent(
          tx,
          reviewAudit(input, input.reviewId, ReviewAuditAction.ReviewAssigned, {
            assigneeId: input.assigneeId,
          }),
        );

        const updated = await getRequiredReviewRow(tx, input);
        return { review: toReviewView(updated) };
      });
    },

    async start(input: Input & { reviewId: string }) {
      const { actor } = await loadProjectContext(input, 'write');
      const current = await getRequiredReviewRow(prisma, input);
      await authorizeProject(prisma, {
        actor,
        projectId: input.projectId,
        permission: ProjectPermission.SubmissionReview,
        resource: submissionResource(current.id, current.submittedById, 'review'),
      });

      return prisma.$transaction(async (tx) => {
        await lockReview(tx, input.reviewId);
        const row = await getRequiredReviewRow(tx, input);
        if (row.status === 'UNDER_REVIEW') {
          return { review: toReviewView(row) };
        }
        assertReviewTransition(row.status, 'UNDER_REVIEW', row.round);

        const result = await tx.review.updateMany({
          where: { id: input.reviewId, status: 'SUBMITTED' },
          data: { status: 'UNDER_REVIEW' },
        });
        if (result.count === 0) {
          throw new AppError(409, 'STALE_ROUND', 'The review changed before it could be started');
        }

        await recordAuditEvent(tx, reviewAudit(input, input.reviewId, ReviewAuditAction.ReviewStarted));

        const updated = await getRequiredReviewRow(tx, input);
        return { review: toReviewView(updated) };
      });
    },

    async resubmit(input: Input & { reviewId: string; round: number }) {
      const { actor } = await loadProjectContext(input, 'write');

      return prisma.$transaction(async (tx) => {
        await lockReview(tx, input.reviewId);
        const row = await getRequiredReviewRow(tx, input);
        await authorizeProject(tx, {
          actor,
          projectId: input.projectId,
          permission: ProjectPermission.SubmissionSubmit,
          resource: submissionResource(row.id, row.submittedById, 'submit'),
        });

        if (row.round !== input.round) {
          throw new AppError(409, 'STALE_ROUND', 'The review round has changed', {
            details: { expected: input.round, actual: row.round },
          });
        }

        await assertChecklistRevisionCurrent(tx, row);
        if (row.checklistId) {
          await assertChecklistReady(tx, row.checklistId);
        }

        assertReviewTransition(row.status, 'SUBMITTED', row.round);
        if (row.status !== 'CHANGES_REQUESTED') {
          throw new AppError(
            409,
            'INVALID_STATUS_TRANSITION',
            'This status transition is not allowed',
            { details: { from: row.status, to: 'SUBMITTED', round: row.round } },
          );
        }

        const result = await tx.review.updateMany({
          where: { id: input.reviewId, round: input.round, status: 'CHANGES_REQUESTED' },
          data: {
            status: 'SUBMITTED',
            round: { increment: 1 },
            submittedAt: new Date(),
          },
        });
        if (result.count === 0) {
          throw new AppError(409, 'STALE_ROUND', 'The review round has changed');
        }

        await recordAuditEvent(
          tx,
          reviewAudit(input, input.reviewId, ReviewAuditAction.ReviewResubmitted, {
            round: row.round,
            nextRound: row.round + 1,
          }),
        );

        const updated = await getRequiredReviewRow(tx, input);
        return { review: toReviewView(updated) };
      });
    },

    async approve(input: Input & { reviewId: string; round: number; note?: string }) {
      return decide(input, 'APPROVED');
    },

    async reject(input: Input & { reviewId: string; round: number; note: string }) {
      return decide(input, 'REJECTED');
    },

    async requestChanges(input: Input & { reviewId: string; round: number; note: string }) {
      return decide(input, 'CHANGES_REQUESTED');
    },
  };
}
