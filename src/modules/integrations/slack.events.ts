import type { PrismaClient } from '@prisma/client';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import {
  createSlackNotificationService,
  type AutomationActionSlackInput,
  type EnqueueSlackNotificationResult,
  type FormSubmittedSlackInput,
  type SlackNotificationService,
  type TaskAssignedSlackInput,
  type TaskDueSoonSlackInput,
  type TaskOverdueSlackInput,
} from './slack-notifications';

/**
 * Slack event seam.
 *
 * Domain services never talk to Slack directly. They hand a persisted event to
 * this notifier after their transaction commits, and it queues one durable
 * outbound job for the workspace's Slack integration. A missing integration, a
 * missing channel or a Slack outage must never fail the task/form write that
 * caused the event, so every domain event here is best-effort: failures are
 * logged and swallowed.
 *
 * The exception is `automationAction`, which backs an explicitly configured
 * automation action. It returns the queue result instead of swallowing it so
 * the automation engine can surface a genuinely misconfigured action (Slack not
 * connected or no channel selected) as a failed run.
 *
 * The message itself is built by `slack-notifications.ts` and carries only the
 * title, status and deep link. Descriptions, comments, attachments and form
 * answers are never sent.
 */
export interface SlackEventNotifier {
  taskAssigned(input: TaskAssignedSlackInput): Promise<void>;
  taskDueSoon(input: TaskDueSoonSlackInput): Promise<void>;
  taskOverdue(input: TaskOverdueSlackInput): Promise<void>;
  formSubmitted(input: FormSubmittedSlackInput): Promise<void>;
  automationAction(input: AutomationActionSlackInput): Promise<EnqueueSlackNotificationResult>;
}

export interface SlackEventNotifierDependencies {
  prisma?: PrismaClient;
  logger?: Logger;
  /** Test seam; defaults to the real queue-backed service. */
  service?: SlackNotificationService;
}

export function createSlackEventNotifier(
  deps: SlackEventNotifierDependencies = {},
): SlackEventNotifier {
  const log = deps.logger ?? defaultLogger;
  const service =
    deps.service ??
    createSlackNotificationService(deps.prisma ? { prisma: deps.prisma } : {});

  async function enqueue(
    event: string,
    identifiers: Record<string, unknown>,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      log.warn('slack_event_enqueue_failed', { event, ...identifiers, error });
    }
  }

  return {
    async taskAssigned(input) {
      await enqueue(
        'task.assigned',
        { workspaceId: input.workspaceId, taskId: input.taskId },
        () => service.enqueueTaskAssigned(input),
      );
    },
    async taskDueSoon(input) {
      await enqueue(
        'task.due_soon',
        { workspaceId: input.workspaceId, taskId: input.taskId },
        () => service.enqueueTaskDueSoon(input),
      );
    },
    async taskOverdue(input) {
      await enqueue(
        'task.overdue',
        { workspaceId: input.workspaceId, taskId: input.taskId },
        () => service.enqueueTaskOverdue(input),
      );
    },
    async formSubmitted(input) {
      await enqueue('form.submitted', { workspaceId: input.workspaceId, formId: input.formId }, () =>
        service.enqueueFormSubmitted(input),
      );
    },
    async automationAction(input) {
      return service.enqueueAutomationAction(input);
    },
  };
}
