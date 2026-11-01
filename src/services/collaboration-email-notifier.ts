import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/env';
import { getPrismaClient } from '../db/prisma';
import { logger as defaultLogger, type Logger } from '../utils/logger';
import {
  buildEmailBrand,
  buildMeetingInvitationEmail,
  buildMentionEmail,
  sendEmail,
  type EmailDeliveryResult,
  type EmailMessage,
} from './email';
import { redactEmailAddresses, summarizeErrorForLog } from './email/log-privacy';
import { isAddressSuppressed } from './email/suppression.service';

export type CollaborationEmailStatus =
  'queued' | 'suppressed' | 'not_found' | 'ineligible' | 'failed';

export interface CollaborationEmailResult {
  status: CollaborationEmailStatus;
  accepted: boolean;
  deliveryId?: string;
}

export type CollaborationEmailSender = (message: EmailMessage) => Promise<EmailDeliveryResult>;

export interface CollaborationEmailNotifierDependencies {
  prisma?: PrismaClient;
  logger?: Logger;
  send?: CollaborationEmailSender;
  isSuppressed?: (client: PrismaClient, address: string) => Promise<boolean>;
}

export interface NotifyCommentMentionInput {
  commentId: string;
  mentionedUserId: string;
}

export interface NotifyMeetingInvitationInput {
  /** Stable identifier for this invitation event, not a bearer token. */
  invitationId: string;
  invitationStatus: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  inviteeId: string;
  inviteeEmail: string;
  inviteeName: string;
  organizerName: string;
  meetingTitle: string;
  startsAt: Date;
  durationMinutes?: number;
  location?: string;
  meetingId: string;
}

export interface CollaborationEmailNotifier {
  notifyMention(input: NotifyCommentMentionInput): Promise<CollaborationEmailResult>;
  notifyMeetingInvitation(input: NotifyMeetingInvitationInput): Promise<CollaborationEmailResult>;
}

function appUrl(config: AppConfig, path: string): string {
  return `${config.emailAppUrl.replace(/\/+$/, '')}${path}`;
}

function configuredPath(path: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`:${key}`, encodeURIComponent(value)),
    path,
  );
}

export function collaborationEmailIdempotencyKey(
  kind: 'mention' | 'meeting-invitation',
  id: string,
  recipientId: string,
): string {
  return `${kind}:${id}:${recipientId}`;
}

/**
 * Post-commit email integration for collaboration events. Mention recipients
 * are resolved from the persisted comment's workspace membership; this
 * service deliberately does not parse comment text or create notifications.
 * Meeting invitations are supplied only by the meeting workflow after it has
 * authorized and persisted a pending invitation (that workflow is not yet in
 * this repository).
 */
export function createCollaborationEmailNotifier(
  config: AppConfig,
  deps: CollaborationEmailNotifierDependencies = {},
): CollaborationEmailNotifier {
  const client = deps.prisma ?? getPrismaClient();
  const log = deps.logger ?? defaultLogger;
  const send = deps.send ?? sendEmail;
  const suppressed = deps.isSuppressed ?? isAddressSuppressed;
  const brand = buildEmailBrand(config);

  async function deliver(
    message: EmailMessage,
    eventId: string,
    recipientId: string,
  ): Promise<CollaborationEmailResult> {
    if (await suppressed(client, message.to)) {
      return { status: 'suppressed', accepted: false };
    }

    try {
      const result = await send(message);

      if (!result.accepted) {
        log.warn('collaboration_email_failed', {
          template: message.template,
          eventId,
          recipientId,
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
      log.error('collaboration_email_failed', {
        template: message.template,
        eventId,
        recipientId,
        error: summarizeErrorForLog(error),
      });
      return { status: 'failed', accepted: false };
    }
  }

  return {
    async notifyMention(input): Promise<CollaborationEmailResult> {
      const comment = await client.comment.findUnique({
        where: { id: input.commentId },
        select: {
          id: true,
          body: true,
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
                  deletedAt: true,
                  workspace: { select: { id: true, name: true, status: true, deletedAt: true } },
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
      if (!recipient) return { status: 'ineligible', accepted: false };

      const membership = await client.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: comment.task.project.workspace.id,
            userId: recipient.id,
          },
        },
        select: { id: true },
      });
      if (!membership) return { status: 'ineligible', accepted: false };

      const message = buildMentionEmail({
        to: recipient.email,
        name: recipient.name,
        brand,
        mentionedByName: comment.author.name,
        context: comment.task.title,
        contextUrl: appUrl(
          config,
          configuredPath(config.commentMentionLinkPath, {
            projectId: comment.task.project.id,
            taskId: comment.task.id,
            commentId: comment.id,
          }),
        ),
        idempotencyKey: collaborationEmailIdempotencyKey('mention', comment.id, recipient.id),
      });
      message.metadata = {
        ...message.metadata,
        commentId: comment.id,
        taskId: comment.task.id,
        projectId: comment.task.project.id,
        workspaceId: comment.task.project.workspace.id,
      };

      return deliver(message, comment.id, recipient.id);
    },

    async notifyMeetingInvitation(input): Promise<CollaborationEmailResult> {
      if (input.invitationStatus !== 'PENDING') {
        return { status: 'ineligible', accepted: false };
      }
      if (
        !input.invitationId ||
        !input.inviteeId ||
        !input.meetingId ||
        !Number.isFinite(input.startsAt.getTime())
      ) {
        return { status: 'ineligible', accepted: false };
      }

      const message = buildMeetingInvitationEmail({
        to: input.inviteeEmail,
        name: input.inviteeName,
        brand,
        meetingTitle: input.meetingTitle,
        organizerName: input.organizerName,
        startsAt: input.startsAt,
        ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}),
        ...(input.location ? { location: input.location } : {}),
        joinUrl: appUrl(
          config,
          configuredPath(config.meetingInvitationLinkPath, { meetingId: input.meetingId }),
        ),
        idempotencyKey: collaborationEmailIdempotencyKey(
          'meeting-invitation',
          input.invitationId,
          input.inviteeId,
        ),
      });
      message.metadata = {
        ...message.metadata,
        invitationId: input.invitationId,
        meetingId: input.meetingId,
      };

      return deliver(message, input.invitationId, input.inviteeId);
    },
  };
}
