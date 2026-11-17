import type { PrismaClient } from '@prisma/client';
import type { WorkerHealthRecorder } from './worker-health';
import type { Logger } from '../../utils/logger';
import { logger as defaultLogger } from '../../utils/logger';
import { createNotification } from '../notifications';
import type { SlackEventNotifier } from '../../modules/integrations/slack.events';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 300_000;
const BATCH_SIZE = 100;

export interface TaskDeadlineNotificationWorker {
  start(): void;
  stop(): Promise<void>;
  runOnce(currentTime?: Date): Promise<{ dueSoon: number; overdue: number }>;
}

export interface TaskDeadlineNotificationWorkerDeps {
  prisma: PrismaClient;
  logger?: Logger;
  pollIntervalMs?: number;
  now?: () => Date;
  health?: WorkerHealthRecorder;
  /** Best-effort Slack delivery for due-soon/overdue task events. */
  slackNotifier?: SlackEventNotifier;
}

function taskLink(projectId: string, taskId: string): string {
  return `/app/projects/${projectId}/tasks/${taskId}/work`;
}

export function createTaskDeadlineNotificationWorker(
  deps: TaskDeadlineNotificationWorkerDeps,
): TaskDeadlineNotificationWorker {
  const log = deps.logger ?? defaultLogger;
  const nowFn = deps.now ?? (() => new Date());
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let running = false;

  async function notifyDueSoon(now: Date): Promise<number> {
    const windowEnd = new Date(now.getTime() + TWENTY_FOUR_HOURS_MS);
    let notified = 0;

    // Tasks due within 24h (not yet due): now >= dueDate-24h => dueDate <= now+24h, and dueDate > now
    const candidates = await deps.prisma.task.findMany({
      where: {
        dueDate: { gt: now, lte: windowEnd },
        dueSoonNotifiedAt: null,
        deletedAt: null,
        archivedAt: null,
        completedAt: null,
        status: { not: 'APPROVED' },
        assignees: { some: {} },
      },
      select: { id: true },
      take: BATCH_SIZE,
      orderBy: { dueDate: 'asc' },
    });

    for (const candidate of candidates) {
      const notifiedTask = await deps.prisma.$transaction(async (tx) => {
        const claimed = await tx.task.updateMany({
          where: {
            id: candidate.id,
            dueSoonNotifiedAt: null,
            dueDate: { gt: now, lte: windowEnd },
            deletedAt: null,
            archivedAt: null,
            completedAt: null,
            status: { not: 'APPROVED' },
          },
          data: { dueSoonNotifiedAt: now },
        });
        if (claimed.count !== 1) return null;

        const task = await tx.task.findUnique({
          where: { id: candidate.id },
          select: {
            id: true,
            title: true,
            key: true,
            status: true,
            projectId: true,
            dueDate: true,
            project: { select: { workspaceId: true } },
            assignees: { select: { userId: true } },
          },
        });
        if (!task || task.assignees.length === 0) return null;

        const title = `Task due soon: ${task.title}`;
        const body = task.dueDate
          ? `“${task.key} ${task.title}” is due within 24 hours (${task.dueDate.toISOString()}).`
          : `“${task.key} ${task.title}” is due within 24 hours.`;
        const link = taskLink(task.projectId, task.id);
        for (const assignee of task.assignees) {
          await createNotification(tx, {
            userId: assignee.userId,
            type: 'TASK_DUE_SOON',
            title,
            body,
            link,
            data: {
              workspaceId: task.project.workspaceId,
              projectId: task.projectId,
              taskId: task.id,
            },
          });
        }
        return {
          workspaceId: task.project.workspaceId,
          projectId: task.projectId,
          taskId: task.id,
          taskKey: task.key,
          taskTitle: task.title,
          status: task.status,
          dueDate: task.dueDate?.toISOString() ?? null,
        };
      });
      if (!notifiedTask) continue;
      notified += 1;
      await deps.slackNotifier?.taskDueSoon({
        workspaceId: notifiedTask.workspaceId,
        projectId: notifiedTask.projectId,
        taskId: notifiedTask.taskId,
        taskKey: notifiedTask.taskKey,
        taskTitle: notifiedTask.taskTitle,
        status: notifiedTask.status,
        dueSoonNotifiedAt: now.toISOString(),
      });
    }

    return notified;
  }

  async function notifyOverdue(now: Date): Promise<number> {
    let notified = 0;

    const candidates = await deps.prisma.task.findMany({
      where: {
        dueDate: { lte: now },
        overdueNotifiedAt: null,
        deletedAt: null,
        archivedAt: null,
        completedAt: null,
        status: { not: 'APPROVED' },
        assignees: { some: {} },
      },
      select: { id: true },
      take: BATCH_SIZE,
      orderBy: { dueDate: 'asc' },
    });

    for (const candidate of candidates) {
      const notifiedTask = await deps.prisma.$transaction(async (tx) => {
        const claimed = await tx.task.updateMany({
          where: {
            id: candidate.id,
            overdueNotifiedAt: null,
            dueDate: { lte: now },
            deletedAt: null,
            archivedAt: null,
            completedAt: null,
            status: { not: 'APPROVED' },
          },
          data: { overdueNotifiedAt: now },
        });
        if (claimed.count !== 1) return null;

        const task = await tx.task.findUnique({
          where: { id: candidate.id },
          select: {
            id: true,
            title: true,
            key: true,
            status: true,
            projectId: true,
            dueDate: true,
            project: { select: { workspaceId: true } },
            assignees: { select: { userId: true } },
          },
        });
        if (!task || task.assignees.length === 0) return null;

        const title = `Task overdue: ${task.title}`;
        const body = task.dueDate
          ? `“${task.key} ${task.title}” was due on ${task.dueDate.toISOString()} and is now overdue.`
          : `“${task.key} ${task.title}” is now overdue.`;
        const link = taskLink(task.projectId, task.id);
        for (const assignee of task.assignees) {
          await createNotification(tx, {
            userId: assignee.userId,
            type: 'TASK_OVERDUE',
            title,
            body,
            link,
            data: {
              workspaceId: task.project.workspaceId,
              projectId: task.projectId,
              taskId: task.id,
            },
          });
        }
        return {
          workspaceId: task.project.workspaceId,
          projectId: task.projectId,
          taskId: task.id,
          taskKey: task.key,
          taskTitle: task.title,
          status: task.status,
          dueDate: task.dueDate?.toISOString() ?? now.toISOString(),
        };
      });
      if (!notifiedTask) continue;
      notified += 1;
      await deps.slackNotifier?.taskOverdue({
        workspaceId: notifiedTask.workspaceId,
        projectId: notifiedTask.projectId,
        taskId: notifiedTask.taskId,
        taskKey: notifiedTask.taskKey,
        taskTitle: notifiedTask.taskTitle,
        status: notifiedTask.status,
        dueDate: notifiedTask.dueDate,
      });
    }

    return notified;
  }

  async function runOnce(currentTime?: Date): Promise<{ dueSoon: number; overdue: number }> {
    const now = currentTime ?? nowFn();
    const dueSoon = await notifyDueSoon(now);
    const overdue = await notifyOverdue(now);
    return { dueSoon, overdue };
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    running = true;
    deps.health?.passStarted();
    try {
      const result = await runOnce();
      if (result.dueSoon || result.overdue) {
        log.info('task_deadline_notification_pass_complete', result);
      }
      deps.health?.succeeded();
    } catch (error) {
      log.error('task_deadline_notification_pass_failed', { error });
      deps.health?.failed(error);
    } finally {
      running = false;
      if (!stopped) {
        timer = setTimeout(() => void tick(), pollIntervalMs);
        timer.unref();
      }
    }
  }

  return {
    start(): void {
      if (!stopped) return;
      stopped = false;
      deps.health?.started();
      timer = setTimeout(() => void tick(), 0);
      timer.unref();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      while (running) await new Promise((resolve) => setTimeout(resolve, 25));
      deps.health?.stopped();
    },
    runOnce,
  };
}
