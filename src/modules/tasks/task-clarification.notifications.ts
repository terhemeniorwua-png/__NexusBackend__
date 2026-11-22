import type { NotificationClient } from '../../services/notifications';
import { recordFanoutEvent } from '../../services/notification-fanout';

/**
 * BE-7 notifications are audited fan-out events written through BE-5's registry.
 * The registry resolves recipients from database state, caps them at 25, excludes
 * the actor, honours in-app preferences and deduplicates with BE-5's
 * `data.dedupeKey` index. All calls must use the same transaction client as the
 * clarification write.
 */
interface ClarificationContext {
  workspaceId: string;
  projectId: string;
  taskId: string;
  taskKey: string;
  creatorId: string | null;
  reviewerId: string | null;
  askerId: string;
  clarificationId: string;
  round: number;
}

export async function notifyClarificationRequested(
  client: NotificationClient,
  input: ClarificationContext & { question: string },
): Promise<void> {
  await recordFanoutEvent(client, {
    action: 'task.clarification_requested',
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actorId: input.askerId,
    targetType: 'TaskClarification',
    targetId: input.clarificationId,
    dedupeKey: `task.clarification.requested:${input.clarificationId}`,
    context: {
      taskId: input.taskId,
      taskKey: input.taskKey,
      creatorId: input.creatorId,
      reviewerId: input.reviewerId,
      askerId: input.askerId,
      clarificationId: input.clarificationId,
      round: input.round,
      question: input.question,
    },
  });
}

export async function notifyClarificationAnswered(
  client: NotificationClient,
  input: ClarificationContext & {
    actorId: string;
    answer: string;
  },
): Promise<void> {
  await recordFanoutEvent(client, {
    action: 'task.clarification_answered',
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actorId: input.actorId,
    targetType: 'TaskClarification',
    targetId: input.clarificationId,
    dedupeKey: `task.clarification.answered:${input.clarificationId}`,
    context: {
      taskId: input.taskId,
      taskKey: input.taskKey,
      creatorId: input.creatorId,
      reviewerId: input.reviewerId,
      askerId: input.askerId,
      clarificationId: input.clarificationId,
      round: input.round,
      answer: input.answer,
    },
  });
}
