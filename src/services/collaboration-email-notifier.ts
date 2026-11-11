import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config/env';
import { getPrismaClient } from '../db/prisma';
import { hashSecret } from '../utils/crypto';
import { logger as defaultLogger, type Logger } from '../utils/logger';
import {
  buildEmailBrand,
  buildMeetingInvitationEmail,
  buildMentionEmail,
  buildProjectInvitationEmail,
  buildTeamInvitationEmail,
  sendEmail,
  type EmailDeliveryResult,
  type EmailMessage,
} from './email';
import { redactEmailAddresses, summarizeErrorForLog } from './email/log-privacy';
import { isAddressSuppressed } from './email/suppression.service';
import { isEmailNotificationEnabled } from './notification-preferences';

export type CollaborationEmailStatus =
  'queued' | 'suppressed' | 'not_found' | 'ineligible' | 'preference_disabled' | 'failed';

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
  isEmailEnabled?: typeof isEmailNotificationEnabled;
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
  /** Workspace the meeting belongs to, when the workflow has one. */
  workspaceId?: string;
  /** Workspace the meeting belongs to, when the workflow has one. */
  workspaceName?: string;
  /** Project the meeting belongs to, when the workflow has one. */
  projectName?: string;
}

export interface NotifyTeamInvitationInput {
  /** Identifier of the persisted TEAM invitation. */
  invitationId: string;
  /**
   * The raw single-use token created by the invitation workflow. Only the
   * digest is stored in PostgreSQL, so the notifier needs the plaintext token
   * to build the acceptance link. It is verified against the persisted digest
   * and is never logged or written to the outbox metadata.
   */
  token: string;
}

export interface NotifyProjectInvitationInput {
  /** Identifier of the persisted PROJECT invitation. */
  invitationId: string;
  /**
   * The raw single-use token created by the invitation workflow. Only its
   * digest is stored in PostgreSQL, so it is verified against `tokenHash`
   * before it is used to build the acceptance link. It is never logged or
   * written to the outbox metadata.
   */
  token: string;
}

export interface CollaborationEmailNotifier {
  notifyMention(input: NotifyCommentMentionInput): Promise<CollaborationEmailResult>;
  notifyMeetingInvitation(input: NotifyMeetingInvitationInput): Promise<CollaborationEmailResult>;
  notifyTeamInvitation(input: NotifyTeamInvitationInput): Promise<CollaborationEmailResult>;
  notifyProjectInvitation(input: NotifyProjectInvitationInput): Promise<CollaborationEmailResult>;
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

function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Builds the acceptance link for a team invitation. The public base comes
 * from the existing email application URL and the path is configurable, so
 * the frontend contract can change without a backend deployment.
 */
export function buildTeamInvitationUrl(config: AppConfig, token: string): string {
  return `${config.emailAppUrl.replace(/\/+$/, '')}${config.teamInvitationLinkPath}?token=${encodeURIComponent(token)}`;
}

export function buildProjectInvitationUrl(config: AppConfig, token: string): string {
  return `${config.emailAppUrl.replace(/\/+$/, '')}${config.projectInvitationLinkPath}?token=${encodeURIComponent(token)}`;
}

export function collaborationEmailIdempotencyKey(
  kind: 'mention' | 'meeting-invitation',
  id: string,
  recipientId: string,
): string {
  return `${kind}:${id}:${recipientId}`;
}

/**
 * A team invitation is unique per persisted invitation and token. Re-sending
 * the same token collapses into one outbox row, while a resend that issues a
 * new token produces a new key and therefore a new email.
 */
export function teamInvitationEmailIdempotencyKey(invitationId: string, tokenHash: string): string {
  return `team-invitation:${invitationId}:${tokenHash}`;
}

export function projectInvitationEmailIdempotencyKey(
  invitationId: string,
  tokenHash: string,
): string {
  return `project-invitation:${invitationId}:${tokenHash}`;
}

/**
 * Post-commit email integration for collaboration events. Mention recipients
 * are resolved from the persisted comment's workspace membership; this
 * service deliberately does not parse comment text or create notifications.
 *
 * Meeting invitations are supplied only by the meeting workflow after it has
 * authorized and persisted a pending invitation. Team and project invitations
 * are supplied only by their invitation workflows after they have persisted a
 * `TEAM` or `PROJECT` invitation and issued its token. None of the meeting,
 * team or project invitation creation/acceptance flows is implemented here:
 * the notifier never creates, revokes, expires or accepts an invitation.
 */
export function createCollaborationEmailNotifier(
  config: AppConfig,
  deps: CollaborationEmailNotifierDependencies = {},
): CollaborationEmailNotifier {
  const client = deps.prisma ?? getPrismaClient();
  const log = deps.logger ?? defaultLogger;
  const send = deps.send ?? sendEmail;
  const suppressed = deps.isSuppressed ?? isAddressSuppressed;
  const emailEnabled = deps.isEmailEnabled ?? isEmailNotificationEnabled;
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

      if (
        !(await emailEnabled(client, {
          workspaceId: comment.task.project.workspace.id,
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
      try {
        if (input.invitationStatus !== 'PENDING') {
          return { status: 'ineligible', accepted: false };
        }
        if (
          !input.invitationId ||
          !input.inviteeId ||
          !input.meetingId ||
          !input.meetingTitle.trim() ||
          !input.organizerName.trim() ||
          !isEmailAddress(input.inviteeEmail) ||
          !(input.startsAt instanceof Date) ||
          !Number.isFinite(input.startsAt.getTime()) ||
          (input.durationMinutes !== undefined &&
            (!Number.isFinite(input.durationMinutes) || input.durationMinutes <= 0))
        ) {
          return { status: 'ineligible', accepted: false };
        }

        if (
          input.workspaceId &&
          !(await emailEnabled(client, {
            workspaceId: input.workspaceId,
            userId: input.inviteeId,
            type: 'MEETING_INVITE',
          }))
        ) {
          return { status: 'preference_disabled', accepted: false };
        }

        const message = buildMeetingInvitationEmail({
          to: input.inviteeEmail.trim(),
          name: input.inviteeName,
          brand,
          meetingTitle: input.meetingTitle,
          organizerName: input.organizerName,
          startsAt: input.startsAt,
          ...(input.durationMinutes ? { durationMinutes: input.durationMinutes } : {}),
          ...(input.location ? { location: input.location } : {}),
          ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
          ...(input.projectName ? { projectName: input.projectName } : {}),
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

        return await deliver(message, input.invitationId, input.inviteeId);
      } catch (error) {
        log.error('collaboration_email_failed', {
          template: 'meeting_invitation',
          eventId: input.invitationId,
          recipientId: input.inviteeId,
          error: summarizeErrorForLog(error),
        });

        return { status: 'failed', accepted: false };
      }
    },

    async notifyTeamInvitation(input): Promise<CollaborationEmailResult> {
      try {
        if (!input.invitationId || !input.token) {
          return { status: 'ineligible', accepted: false };
        }

        const invitation = await client.invitation.findUnique({
          where: { id: input.invitationId },
          select: {
            id: true,
            email: true,
            type: true,
            status: true,
            teamId: true,
            workspaceId: true,
            expiresAt: true,
            forUserId: true,
            tokenHash: true,
            workspace: { select: { id: true, name: true, status: true, deletedAt: true } },
            invitedBy: { select: { id: true, name: true, status: true, deletedAt: true } },
          },
        });

        // A team invitation must be a persisted TEAM invitation that belongs
        // to an active team inside an active workspace.
        if (
          !invitation ||
          invitation.type !== 'TEAM' ||
          !invitation.teamId ||
          invitation.workspace.deletedAt ||
          invitation.workspace.status !== 'ACTIVE' ||
          invitation.invitedBy.deletedAt ||
          invitation.invitedBy.status !== 'ACTIVE'
        ) {
          return { status: 'not_found', accepted: false };
        }

        // The notifier never expires or revokes an invitation: it only
        // refuses to send for one that is no longer valid.
        if (
          invitation.status !== 'PENDING' ||
          !Number.isFinite(invitation.expiresAt.getTime()) ||
          invitation.expiresAt.getTime() <= Date.now() ||
          !isEmailAddress(invitation.email)
        ) {
          return { status: 'ineligible', accepted: false };
        }

        // An invitation bound to an account cannot be emailed to a deleted or
        // suspended account.
        let inviteeName = 'there';

        if (invitation.forUserId) {
          const boundUser = await client.user.findFirst({
            where: { id: invitation.forUserId, status: 'ACTIVE', deletedAt: null },
            select: { id: true, name: true },
          });

          if (!boundUser) {
            return { status: 'ineligible', accepted: false };
          }

          inviteeName = boundUser.name;

          const workspaceMembership = await client.workspaceMembership.findUnique({
            where: {
              workspaceId_userId: {
                workspaceId: invitation.workspaceId,
                userId: invitation.forUserId,
              },
            },
            select: { status: true },
          });
          if (workspaceMembership?.status !== 'ACTIVE') {
            return { status: 'ineligible', accepted: false };
          }
        }

        const team = await client.team.findFirst({
          where: {
            id: invitation.teamId,
            workspaceId: invitation.workspaceId,
            status: 'ACTIVE',
            deletedAt: null,
          },
          select: { id: true, name: true },
        });

        if (!team) {
          return { status: 'not_found', accepted: false };
        }

        // Only the digest is stored, so a token that does not match the
        // persisted invitation cannot be turned into an acceptance link.
        if (hashSecret(input.token) !== invitation.tokenHash) {
          return { status: 'ineligible', accepted: false };
        }

        const message = buildTeamInvitationEmail({
          to: invitation.email,
          name: inviteeName,
          brand,
          inviterName: invitation.invitedBy.name,
          teamName: team.name,
          workspaceName: invitation.workspace.name,
          acceptUrl: buildTeamInvitationUrl(config, input.token),
          expiresAt: invitation.expiresAt,
          idempotencyKey: teamInvitationEmailIdempotencyKey(invitation.id, invitation.tokenHash),
        });
        message.metadata = {
          ...message.metadata,
          invitationId: invitation.id,
          teamId: team.id,
          workspaceId: invitation.workspaceId,
        };

        return await deliver(
          message,
          invitation.id,
          invitation.forUserId ?? 'unregistered-invitee',
        );
      } catch (error) {
        log.error('collaboration_email_failed', {
          template: 'team_invitation',
          eventId: input.invitationId,
          error: summarizeErrorForLog(error),
        });

        return { status: 'failed', accepted: false };
      }
    },

    async notifyProjectInvitation(input): Promise<CollaborationEmailResult> {
      try {
        if (!input.invitationId || !input.token) {
          return { status: 'ineligible', accepted: false };
        }

        const invitation = await client.invitation.findUnique({
          where: { id: input.invitationId },
          select: {
            id: true,
            email: true,
            type: true,
            status: true,
            projectId: true,
            workspaceId: true,
            expiresAt: true,
            forUserId: true,
            tokenHash: true,
            workspace: { select: { id: true, name: true, status: true, deletedAt: true } },
            invitedBy: { select: { id: true, name: true, status: true, deletedAt: true } },
          },
        });

        // A project invitation must be a persisted PROJECT invitation that
        // belongs to a live project inside an active workspace.
        if (
          !invitation ||
          invitation.type !== 'PROJECT' ||
          !invitation.projectId ||
          invitation.workspace.deletedAt ||
          invitation.workspace.status !== 'ACTIVE' ||
          invitation.invitedBy.deletedAt ||
          invitation.invitedBy.status !== 'ACTIVE'
        ) {
          return { status: 'not_found', accepted: false };
        }

        // The notifier never expires or revokes an invitation: it only
        // refuses to send for one that is no longer valid.
        if (
          invitation.status !== 'PENDING' ||
          !Number.isFinite(invitation.expiresAt.getTime()) ||
          invitation.expiresAt.getTime() <= Date.now() ||
          !isEmailAddress(invitation.email)
        ) {
          return { status: 'ineligible', accepted: false };
        }

        // An invitation bound to an account cannot be emailed to a deleted or
        // suspended account.
        let inviteeName = 'there';

        if (invitation.forUserId) {
          const boundUser = await client.user.findFirst({
            where: { id: invitation.forUserId, status: 'ACTIVE', deletedAt: null },
            select: { id: true, name: true },
          });

          if (!boundUser) {
            return { status: 'ineligible', accepted: false };
          }

          inviteeName = boundUser.name;
        }

        const project = await client.project.findFirst({
          where: {
            id: invitation.projectId,
            workspaceId: invitation.workspaceId,
            deletedAt: null,
            status: { not: 'ARCHIVED' },
          },
          select: { id: true, name: true },
        });

        if (!project) {
          return { status: 'not_found', accepted: false };
        }

        // Only the digest is stored, so a token that does not match the
        // persisted invitation cannot be turned into an acceptance link.
        if (hashSecret(input.token) !== invitation.tokenHash) {
          return { status: 'ineligible', accepted: false };
        }

        const message = buildProjectInvitationEmail({
          to: invitation.email,
          name: inviteeName,
          brand,
          inviterName: invitation.invitedBy.name,
          projectName: project.name,
          workspaceName: invitation.workspace.name,
          acceptUrl: buildProjectInvitationUrl(config, input.token),
          expiresAt: invitation.expiresAt,
          idempotencyKey: projectInvitationEmailIdempotencyKey(invitation.id, invitation.tokenHash),
        });
        message.metadata = {
          ...message.metadata,
          invitationId: invitation.id,
          projectId: project.id,
          projectName: project.name,
          workspaceId: invitation.workspaceId,
        };

        return await deliver(
          message,
          invitation.id,
          invitation.forUserId ?? 'unregistered-invitee',
        );
      } catch (error) {
        log.error('collaboration_email_failed', {
          template: 'project_invitation',
          eventId: input.invitationId,
          error: summarizeErrorForLog(error),
        });

        return { status: 'failed', accepted: false };
      }
    },
  };
}
