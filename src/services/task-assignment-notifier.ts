import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/env';
import { getPrismaClient } from '../db/prisma';
import { logger as defaultLogger, type Logger } from '../utils/logger';
import {
  buildEmailBrand,
  buildTaskAssignmentEmail,
  sendEmail,
  type EmailDeliveryResult,
  type EmailMessage,
} from './email';
import { redactEmailAddresses, summarizeErrorForLog } from './email/log-privacy';
import { isAddressSuppressed } from './email/suppression.service';
import { isEmailNotificationEnabled } from './notification-preferences';

/**
 * Task assignment email notifier.
 *
 * The Phase 9 task service owns assignment persistence and authorization. This
 * service is the reusable post-commit boundary that turns a persisted
 * assignment into an email. It deliberately does not write task data, so a
 * provider failure cannot roll back an assignment that has already been
 * committed.
 *
 * Duplicate events are safe because the outbox idempotency key contains the
 * assignment timestamp. Re-processing the same assignment event reuses one
 * delivery row, while a genuinely new assignment receives a new key.
 */

export type TaskAssignmentNoticeStatus =
  'queued' | 'suppressed' | 'not_found' | 'ineligible' | 'preference_disabled' | 'failed';

export interface TaskAssignmentNoticeResult {
  status: TaskAssignmentNoticeStatus;
  accepted: boolean;
  deliveryId?: string;
}

export type TaskAssignmentEmailSender = (message: EmailMessage) => Promise<EmailDeliveryResult>;

export interface TaskAssignmentNotifierDependencies {
  prisma?: PrismaClient;
  logger?: Logger;
  send?: TaskAssignmentEmailSender;
  isSuppressed?: (client: PrismaClient, address: string) => Promise<boolean>;
  isEmailEnabled?: typeof isEmailNotificationEnabled;
}

export interface NotifyTaskAssignmentInput {
  taskId: string;
  assigneeId: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Builds the link that opens the task in the frontend.
 *
 * The public base comes from the existing email application URL setting, and
 * the path is configurable because the frontend route is part of the API
 * contract.
 */
export function buildTaskAssignmentUrl(
  config: AppConfig,
  input: { projectId: string; taskId: string },
): string {
  const path = config.taskAssignmentLinkPath
    .replaceAll(':projectId', encodeURIComponent(input.projectId))
    .replaceAll(':taskId', encodeURIComponent(input.taskId));

  return `${trimTrailingSlash(config.emailAppUrl)}${path}`;
}

/**
 * Stable key for one assignment event. A repeated delivery of the same event
 * resolves to the same outbox row, while a later assignment of the same task
 * to the same user has a new `assignedAt` and a new key.
 */
export function taskAssignmentIdempotencyKey(input: {
  taskId: string;
  assigneeId: string;
  assignedAt: Date;
}): string {
  return `task-assignment:${input.taskId}:${input.assigneeId}:${input.assignedAt.toISOString()}`;
}

export interface TaskAssignmentNotifier {
  notify(input: NotifyTaskAssignmentInput): Promise<TaskAssignmentNoticeResult>;
}

export function createTaskAssignmentNotifier(
  config: AppConfig,
  deps: TaskAssignmentNotifierDependencies = {},
): TaskAssignmentNotifier {
  const client = deps.prisma ?? getPrismaClient();
  const log = deps.logger ?? defaultLogger;
  const send = deps.send ?? sendEmail;
  const suppressed = deps.isSuppressed ?? isAddressSuppressed;
  const emailEnabled = deps.isEmailEnabled ?? isEmailNotificationEnabled;
  const brand = buildEmailBrand(config);

  return {
    async notify(input): Promise<TaskAssignmentNoticeResult> {
      try {
        const assignment = await client.taskAssignee.findUnique({
          where: {
            taskId_userId: {
              taskId: input.taskId,
              userId: input.assigneeId,
            },
          },
          select: {
            assignedAt: true,
            assigner: { select: { id: true, name: true } },
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                status: true,
                deletedAt: true,
              },
            },
            task: {
              select: {
                id: true,
                title: true,
                dueDate: true,
                deletedAt: true,
                creator: { select: { name: true } },
                project: {
                  select: {
                    id: true,
                    name: true,
                    ownerId: true,
                    deletedAt: true,
                    workspace: {
                      select: {
                        id: true,
                        name: true,
                        status: true,
                        deletedAt: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });

        if (
          !assignment ||
          assignment.task.deletedAt ||
          assignment.task.project.deletedAt ||
          assignment.task.project.workspace.deletedAt ||
          assignment.task.project.workspace.status !== 'ACTIVE'
        ) {
          return { status: 'not_found', accepted: false };
        }

        const { user, task } = assignment;
        const project = task.project;
        const workspace = project.workspace;

        if (user.deletedAt || user.status !== 'ACTIVE') {
          return { status: 'ineligible', accepted: false };
        }

        const membership = await client.workspaceMembership.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: workspace.id,
              userId: user.id,
            },
          },
          select: { role: true },
        });

        if (!membership) {
          return { status: 'ineligible', accepted: false };
        }

        const isWorkspaceManager =
          membership.role === 'OWNER' || membership.role === 'PROJECT_MANAGER';

        if (!isWorkspaceManager && project.ownerId !== user.id) {
          const projectMembership = await client.projectMembership.findUnique({
            where: {
              projectId_userId: {
                projectId: project.id,
                userId: user.id,
              },
            },
            select: { id: true },
          });

          if (!projectMembership) {
            return { status: 'ineligible', accepted: false };
          }
        }

        if (await suppressed(client, user.email)) {
          return { status: 'suppressed', accepted: false };
        }

        if (
          !(await emailEnabled(client, {
            workspaceId: workspace.id,
            userId: user.id,
            type: 'TASK_ASSIGNED',
          }))
        ) {
          return { status: 'preference_disabled', accepted: false };
        }

        const assignedByName = assignment.assigner?.name ?? task.creator.name;
        const message = buildTaskAssignmentEmail({
          to: user.email,
          name: user.name,
          brand,
          taskTitle: task.title,
          projectName: project.name,
          assignedByName,
          ...(task.dueDate ? { dueAt: task.dueDate } : {}),
          taskUrl: buildTaskAssignmentUrl(config, {
            projectId: project.id,
            taskId: task.id,
          }),
          idempotencyKey: taskAssignmentIdempotencyKey({
            taskId: task.id,
            assigneeId: user.id,
            assignedAt: assignment.assignedAt,
          }),
        });

        message.metadata = {
          ...message.metadata,
          taskId: task.id,
          projectId: project.id,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        };

        try {
          const result = await send(message);

          if (!result.accepted) {
            log.warn('task_assignment_email_failed', {
              taskId: task.id,
              assigneeId: user.id,
              error: redactEmailAddresses(result.error ?? 'The email was not accepted'),
            });

            return { status: 'failed', accepted: false };
          }

          return {
            status: 'queued',
            accepted: true,
            ...(result.providerMessageId ? { deliveryId: result.providerMessageId } : {}),
          };
        } catch (error) {
          log.error('task_assignment_email_failed', {
            taskId: task.id,
            assigneeId: user.id,
            error: summarizeErrorForLog(error),
          });

          return { status: 'failed', accepted: false };
        }
      } catch (error) {
        log.error('task_assignment_email_failed', {
          taskId: input.taskId,
          assigneeId: input.assigneeId,
          error: summarizeErrorForLog(error),
        });

        return { status: 'failed', accepted: false };
      }
    },
  };
}
