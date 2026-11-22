import { randomUUID } from 'node:crypto';
import { NotificationType, Prisma } from '@prisma/client';
import {
  ProjectPermission,
  effectiveWorkspaceRole,
  resolveProjectAuthorization,
} from '../modules/authorization';
import { emitToUser } from '../realtime/io-registry';
import { AppError } from '../utils/errors';
import { logger as defaultLogger, type Logger } from '../utils/logger';
import type { NotificationClient } from './notifications';

/**
 * BE-5 in-app notification fan-out.
 *
 * One registry maps a trusted server-side audit action to:
 *   - the NotificationType to write,
 *   - the recipient resolver (who is allowed to receive it), and
 *   - the message builder.
 *
 * Every value used for recipient selection comes from the database, never from
 * a request body or a webhook payload. The caller passes only the audit action
 * and identifiers of the resource that was actually changed.
 */

export const MAX_FANOUT_RECIPIENTS = 25;

const NO_ACCESS_CODES = new Set([
  'PROJECT_NOT_FOUND',
  'PROJECT_ACCESS_DENIED',
  'ORGANIZATION_ROLE_WORKSPACE_MISMATCH',
]);

export interface FanoutEvent {
  /** Server-side audit action, e.g. `review.approved`. */
  action: string;
  workspaceId: string;
  projectId: string;
  /** User who performed the change; never notified for their own change. */
  actorId: string | null;
  targetType: string;
  targetId: string;
  /** Stable idempotency key persisted in `data.dedupeKey`. */
  dedupeKey: string;
  /** Additional DB-derived values only (never client-supplied recipients). */
  context?: Record<string, unknown>;
}

type Audience =
  | 'project'
  | 'reviewers'
  | 'submitter'
  | 'assignee'
  | 'clarification_requested'
  | 'clarification_asker'
  | 'task_stakeholders';

interface MessageDraft {
  title: string;
  body?: string;
}

interface RegistryEntry {
  type: NotificationType;
  audience: Audience;
  message: (event: FanoutEvent) => MessageDraft;
}

const REGISTRY: Record<string, RegistryEntry> = {
  'review.created': {
    type: NotificationType.REVIEW_SUBMITTED,
    audience: 'reviewers',
    message: () => ({
      title: 'Submission sent for review',
      body: 'A submission in your project is waiting for a reviewer.',
    }),
  },
  'review.assigned': {
    type: NotificationType.REVIEW_ASSIGNED,
    audience: 'assignee',
    message: () => ({
      title: 'You were assigned a review',
      body: 'A submission in your project was assigned to you.',
    }),
  },
  'review.started': {
    type: NotificationType.REVIEW_STARTED,
    audience: 'submitter',
    message: () => ({
      title: 'Review started on your submission',
      body: 'A reviewer has started reviewing your submission.',
    }),
  },
  'review.approved': {
    type: NotificationType.REVIEW_APPROVED,
    audience: 'submitter',
    message: () => ({
      title: 'Your submission was approved',
      body: 'A reviewer approved your submission.',
    }),
  },
  'review.rejected': {
    type: NotificationType.REVIEW_REJECTED,
    audience: 'submitter',
    message: () => ({
      title: 'Your submission was rejected',
      body: 'A reviewer rejected your submission.',
    }),
  },
  'review.changes_requested': {
    type: NotificationType.REVIEW_CHANGES_REQUESTED,
    audience: 'submitter',
    message: () => ({
      title: 'Changes requested on your submission',
      body: 'A reviewer requested changes to your submission.',
    }),
  },
  'review.resubmitted': {
    type: NotificationType.REVIEW_RESUBMITTED,
    audience: 'reviewers',
    message: () => ({
      title: 'Submission resubmitted for review',
      body: 'A submission was updated and is ready for another review.',
    }),
  },
  'checklist_item.signed_off': {
    type: NotificationType.CHECKLIST_SIGNED_OFF,
    audience: 'project',
    message: () => ({
      title: 'Checklist item signed off',
      body: 'A checklist item in your project was signed off.',
    }),
  },
  'file.version.created': {
    type: NotificationType.ATTACHMENT_VERSION_ADDED,
    audience: 'project',
    message: () => ({
      title: 'New attachment version uploaded',
      body: 'A new version of a project attachment is available.',
    }),
  },
  'task.clarification_requested': {
    type: NotificationType.TASK_CLARIFICATION_REQUESTED,
    audience: 'clarification_requested',
    message: (event) => {
      const taskKey = contextString(event, 'taskKey') ?? 'a task';
      const question = contextString(event, 'question') ?? '';
      return {
        title: `Clarification requested on ${taskKey}`,
        body: question ? `Question: ${question}` : 'An assignee asked for clarification.',
      };
    },
  },
  'task.clarification_answered': {
    type: NotificationType.TASK_CLARIFICATION_ANSWERED,
    audience: 'clarification_asker',
    message: (event) => {
      const taskKey = contextString(event, 'taskKey') ?? 'a task';
      const answer = contextString(event, 'answer') ?? '';
      return {
        title: `Clarification answered on ${taskKey}`,
        body: answer ? `Answer: ${answer}` : 'Your clarification question was answered.',
      };
    },
  },
  'task.github_pr_merged': {
    type: NotificationType.GITHUB_PR_MERGED,
    audience: 'task_stakeholders',
    message: (event) => {
      const taskTitle = contextString(event, 'taskTitle') ?? 'A task';
      return {
        title: `Linked pull request merged for "${taskTitle}"`,
        body: 'A linked GitHub pull request was merged. Open the task for details.',
      };
    },
  },
  'task.github_review_synced': {
    type: NotificationType.GITHUB_PR_REVIEW_RECEIVED,
    audience: 'task_stakeholders',
    message: (event) => {
      const taskTitle = contextString(event, 'taskTitle') ?? 'A task';
      return {
        title: `New GitHub review on "${taskTitle}"`,
        body: 'A linked GitHub pull request received a review. Open the task for details.',
      };
    },
  },
};

export function isFanoutAction(action: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, action);
}

interface EligibleMember {
  userId: string;
  canReview: boolean;
  canManageProject: boolean;
}

async function eligibleMembers(client: NotificationClient, event: FanoutEvent): Promise<EligibleMember[]> {
  const memberships = await client.workspaceMembership.findMany({
    where: {
      workspaceId: event.workspaceId,
      status: 'ACTIVE',
      user: { deletedAt: null, status: 'ACTIVE' },
    },
    select: {
      userId: true,
      role: true,
      organizationRole: true,
      workspace: { select: { type: true } },
    },
    orderBy: { userId: 'asc' },
  });

  const eligible: EligibleMember[] = [];
  for (const membership of memberships) {
    if (membership.userId === event.actorId) continue;
    const workspaceRole = effectiveWorkspaceRole(
      membership.workspace.type,
      membership.role,
      membership.organizationRole,
    );
    try {
      const authorization = await resolveProjectAuthorization(
        client,
        { userId: membership.userId, workspaceId: event.workspaceId, workspaceRole },
        event.projectId,
      );
      eligible.push({
        userId: membership.userId,
        canReview:
          authorization.permissions.includes(ProjectPermission.SubmissionReview) ||
          authorization.permissions.includes(ProjectPermission.SubmissionApprove),
        canManageProject:
          authorization.isWorkspaceAdmin || authorization.projectRole === 'PROJECT_MANAGER',
      });
    } catch (error) {
      // A member with no access to this project simply is not a recipient.
      // Unexpected failures (database down, etc.) must remain blocking.
      if (error instanceof AppError && NO_ACCESS_CODES.has(error.code)) continue;
      throw error;
    }
  }
  return eligible;
}

function contextUserId(event: FanoutEvent, key: string): string | null {
  const value = event.context?.[key];
  return typeof value === 'string' ? value : null;
}

function contextUserIds(event: FanoutEvent, key: string): string[] {
  const value = event.context?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

function contextString(event: FanoutEvent, key: string): string | null {
  const value = event.context?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function resolveRecipients(
  client: NotificationClient,
  event: FanoutEvent,
  audience: Audience,
): Promise<string[]> {
  const members = await eligibleMembers(client, event);
  const memberIds = new Set(members.map((m) => m.userId));

  let recipients: string[];
  switch (audience) {
    case 'reviewers':
      recipients = members.filter((m) => m.canReview).map((m) => m.userId);
      break;
    case 'assignee': {
      const assigneeId = contextUserId(event, 'assigneeId');
      recipients = members
        .filter((m) => m.canReview && m.userId === assigneeId)
        .map((m) => m.userId);
      break;
    }
    case 'submitter': {
      const submitterId = contextUserId(event, 'submitterId');
      recipients = submitterId && memberIds.has(submitterId) ? [submitterId] : [];
      break;
    }
    case 'project':
      recipients = members.map((m) => m.userId);
      break;
    case 'clarification_requested': {
      // All identifiers come from the task row / authorization resolver, never
      // from the request body. The actor is excluded by eligibleMembers() and
      // again here for creator/reviewer ids supplied in DB-derived context.
      const creatorId = contextUserId(event, 'creatorId');
      const reviewerId = contextUserId(event, 'reviewerId');
      const managerIds = members.filter((m) => m.canManageProject).map((m) => m.userId);
      recipients = [...new Set([creatorId, reviewerId, ...managerIds])].filter(
        (id): id is string =>
          typeof id === 'string' &&
          id.length > 0 &&
          id !== event.actorId &&
          memberIds.has(id),
      );
      break;
    }
    case 'clarification_asker': {
      const askerId = contextUserId(event, 'askerId');
      recipients =
        askerId && askerId !== event.actorId && memberIds.has(askerId) ? [askerId] : [];
      break;
    }
    case 'task_stakeholders': {
      // DB-derived ids only. GitHub sender is not a Nexus user; exclude actor only
      // when the event maps to one (event.actorId is null for webhook sync).
      const creatorId = contextUserId(event, 'creatorId');
      const assigneeIds = contextUserIds(event, 'assigneeIds');
      recipients = [...new Set([creatorId, ...assigneeIds])].filter(
        (id): id is string =>
          typeof id === 'string' &&
          id.length > 0 &&
          id !== event.actorId &&
          memberIds.has(id),
      );
      break;
    }
  }

  return recipients.sort().slice(0, MAX_FANOUT_RECIPIENTS);
}

export interface NotificationDraft {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string;
  dedupeKey: string;
  data: Record<string, unknown>;
}

/**
 * Writes a batch of in-app rows with SQL-level deduplication.
 *
 * `data.dedupeKey` is backed by a partial unique index, so `skipDuplicates`
 * turns a repeated delivery into a no-op instead of a constraint error. No
 * P2002 is caught here: the write stays safe inside a surrounding transaction.
 */
export async function writeNotificationDrafts(
  client: NotificationClient,
  drafts: NotificationDraft[],
): Promise<void> {
  const prepared: Prisma.NotificationCreateManyInput[] = [];

  for (const draft of drafts) {
    const workspaceId = draft.data.workspaceId;
    if (typeof workspaceId !== 'string') continue;

    const preference = await client.notificationPreference.findUnique({
      where: {
        workspaceId_userId_type: { workspaceId, userId: draft.userId, type: draft.type },
      },
      select: { inAppEnabled: true },
    });
    if (preference?.inAppEnabled === false) continue;

    prepared.push({
      id: randomUUID(),
      userId: draft.userId,
      type: draft.type,
      title: draft.title,
      ...(draft.body ? { body: draft.body } : {}),
      data: { ...draft.data, workspaceId, dedupeKey: draft.dedupeKey } as Prisma.InputJsonValue,
    });
  }

  if (prepared.length === 0) return;

  const result = await client.notification.createMany({ data: prepared, skipDuplicates: true });
  if (result.count === 0) return;

  const created = await client.notification.findMany({
    where: {
      id: { in: prepared.map((row) => row.id).filter((id): id is string => typeof id === 'string') },
    },
    select: {
      id: true,
      userId: true,
      type: true,
      title: true,
      body: true,
      link: true,
      data: true,
      readAt: true,
      createdAt: true,
    },
  });
  for (const row of created) {
    emitToUser(row.userId, 'notification.created', {
      notification: {
        id: row.id,
        type: row.type,
        title: row.title,
        body: row.body,
        link: row.link,
        data: (row.data as Record<string, unknown> | null) ?? null,
        readAt: row.readAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      },
    });
  }
}

/**
 * Records the in-app rows for one audited change. Must be called with the same
 * transaction client that writes the change, so a notification failure rolls
 * the whole change back.
 */
export async function recordFanoutEvent(
  client: NotificationClient,
  event: FanoutEvent,
): Promise<void> {
  const entry = REGISTRY[event.action];
  if (!entry) return;

  const recipients = await resolveRecipients(client, event, entry.audience);
  if (recipients.length === 0) return;

  const message = entry.message(event);
  const data: Record<string, unknown> = {
    ...event.context,
    workspaceId: event.workspaceId,
    projectId: event.projectId,
    targetType: event.targetType,
    targetId: event.targetId,
    action: event.action,
  };

  await writeNotificationDrafts(
    client,
    recipients.map((userId) => ({
      userId,
      type: entry.type,
      title: message.title,
      ...(message.body ? { body: message.body } : {}),
      dedupeKey: event.dedupeKey,
      data,
    })),
  );
}

/**
 * Best-effort post-commit fan-out. Use for webhook-driven events where a
 * notification failure must never fail or roll back the already-committed
 * state transition. Runs against the base client, never rethrows.
 */
export async function recordFanoutEventBestEffort(
  client: NotificationClient,
  event: FanoutEvent,
  logger: Logger = defaultLogger,
): Promise<void> {
  try {
    await recordFanoutEvent(client, event);
  } catch (error) {
    logger.warn('notification_fanout_failed', {
      action: event.action,
      workspaceId: event.workspaceId,
      projectId: event.projectId,
      targetType: event.targetType,
      targetId: event.targetId,
      dedupeKey: event.dedupeKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
