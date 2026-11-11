import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/env';
import { getPrismaClient } from '../db/prisma';
import { logger as defaultLogger, type Logger } from '../utils/logger';
import {
  buildEmailBrand,
  buildMentionEmail,
  sendEmail,
  type EmailDeliveryResult,
  type EmailMessage,
} from './email';
import { redactEmailAddresses, summarizeErrorForLog } from './email/log-privacy';
import { isAddressSuppressed } from './email/suppression.service';
import { isEmailNotificationEnabled } from './notification-preferences';

/**
 * Comment mention email notifier.
 *
 * The comment workflow owns mention parsing, persistence and the in-app
 * notification. This service is the post-commit boundary that turns one
 * persisted mention into an email. It never writes comment data, so a
 * provider or outbox failure cannot roll back a comment that was already
 * committed.
 *
 * Duplicate processing is safe because the idempotency key is derived from
 * the comment and the mentioned user. Re-delivering the same mention, or
 * editing the comment without changing who it mentions, reuses one outbox
 * row instead of sending another email.
 */

export type MentionNoticeStatus =
  'queued' | 'suppressed' | 'not_found' | 'ineligible' | 'preference_disabled' | 'failed';

export interface MentionNoticeResult {
  status: MentionNoticeStatus;
  accepted: boolean;
  deliveryId?: string;
}

export type MentionEmailSender = (message: EmailMessage) => Promise<EmailDeliveryResult>;

export interface MentionEmailNotifierDependencies {
  prisma?: PrismaClient;
  logger?: Logger;
  send?: MentionEmailSender;
  isSuppressed?: (client: PrismaClient, address: string) => Promise<boolean>;
  isEmailEnabled?: typeof isEmailNotificationEnabled;
}

export interface NotifyMentionInput {
  commentId: string;
  mentionedUserId: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Builds the link that opens the comment in the frontend.
 *
 * The public base comes from the existing email application URL setting, and
 * the path is configurable because the frontend route is part of the API
 * contract.
 */
export function buildMentionUrl(
  config: AppConfig,
  input: { projectId: string; taskId: string; commentId: string },
): string {
  const path = config.commentMentionLinkPath
    .replaceAll(':projectId', encodeURIComponent(input.projectId))
    .replaceAll(':taskId', encodeURIComponent(input.taskId))
    .replaceAll(':commentId', encodeURIComponent(input.commentId));

  return `${trimTrailingSlash(config.emailAppUrl)}${path}`;
}

/**
 * Stable key for one mention event. A repeated delivery of the same mention,
 * or a comment edit that keeps the same mention, resolves to the same outbox
 * row.
 */
export function mentionEmailIdempotencyKey(commentId: string, mentionedUserId: string): string {
  return `mention:${commentId}:${mentionedUserId}`;
}

export interface MentionEmailNotifier {
  notify(input: NotifyMentionInput): Promise<MentionNoticeResult>;
}

export function createMentionEmailNotifier(
  config: AppConfig,
  deps: MentionEmailNotifierDependencies = {},
): MentionEmailNotifier {
  const client = deps.prisma ?? getPrismaClient();
  const log = deps.logger ?? defaultLogger;
  const send = deps.send ?? sendEmail;
  const suppressed = deps.isSuppressed ?? isAddressSuppressed;
  const emailEnabled = deps.isEmailEnabled ?? isEmailNotificationEnabled;
  const brand = buildEmailBrand(config);

  return {
    async notify(input): Promise<MentionNoticeResult> {
      try {
        const comment = await client.comment.findUnique({
          where: { id: input.commentId },
          select: {
            id: true,
            deletedAt: true,
            authorId: true,
            author: { select: { id: true, name: true } },
            task: {
              select: {
                id: true,
                title: true,
                deletedAt: true,
                project: {
                  select: {
                    id: true,
                    ownerId: true,
                    visibility: true,
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
          !comment ||
          comment.deletedAt ||
          comment.task.deletedAt ||
          comment.task.project.deletedAt ||
          comment.task.project.workspace.deletedAt ||
          comment.task.project.workspace.status !== 'ACTIVE'
        ) {
          return { status: 'not_found', accepted: false };
        }

        if (comment.authorId === input.mentionedUserId) {
          return { status: 'ineligible', accepted: false };
        }

        const recipient = await client.user.findFirst({
          where: { id: input.mentionedUserId, status: 'ACTIVE', deletedAt: null },
          select: { id: true, name: true, email: true },
        });

        if (!recipient) {
          return { status: 'ineligible', accepted: false };
        }

        const project = comment.task.project;
        const workspace = project.workspace;
        const membership = await client.workspaceMembership.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: workspace.id,
              userId: recipient.id,
            },
          },
          select: { role: true },
        });

        if (!membership) {
          return { status: 'ineligible', accepted: false };
        }

        const isWorkspaceManager =
          membership.role === 'OWNER' || membership.role === 'PROJECT_MANAGER';

        if (!isWorkspaceManager && project.ownerId !== recipient.id) {
          const projectMembership = await client.projectMembership.findUnique({
            where: {
              projectId_userId: {
                projectId: project.id,
                userId: recipient.id,
              },
            },
            select: { id: true },
          });

          if (!projectMembership) {
            return { status: 'ineligible', accepted: false };
          }
        }

        if (await suppressed(client, recipient.email)) {
          return { status: 'suppressed', accepted: false };
        }

        if (
          !(await emailEnabled(client, {
            workspaceId: workspace.id,
            userId: recipient.id,
            type: 'MENTION',
          }))
        ) {
          return { status: 'preference_disabled', accepted: false };
        }

        const message = buildMentionEmail({
          to: recipient.email,
          name: recipient.name,
          brand,
          mentionedByName: comment.author.name,
          context: comment.task.title,
          contextUrl: buildMentionUrl(config, {
            projectId: project.id,
            taskId: comment.task.id,
            commentId: comment.id,
          }),
          idempotencyKey: mentionEmailIdempotencyKey(comment.id, recipient.id),
        });

        message.metadata = {
          ...message.metadata,
          commentId: comment.id,
          taskId: comment.task.id,
          projectId: project.id,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
        };

        const result = await send(message);

        if (!result.accepted) {
          log.warn('mention_email_failed', {
            commentId: comment.id,
            mentionedUserId: recipient.id,
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
        log.error('mention_email_failed', {
          commentId: input.commentId,
          mentionedUserId: input.mentionedUserId,
          error: summarizeErrorForLog(error),
        });

        return { status: 'failed', accepted: false };
      }
    },
  };
}
