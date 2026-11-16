import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import type { CollaborationEmailNotifier } from '../../services/collaboration-email-notifier';
import { AppError } from '../../utils/errors';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { ProjectCapability, requireProjectAccess } from '../authorization/project.policy';
import { projectVisibleToUser } from '../projects/project-visibility';

/** Meetings on projects the caller cannot see are hidden. Unrestricted legacy managers bypass, as in the project list. */
function meetingVisibility(userId: string, unrestricted: boolean): Prisma.MeetingWhereInput {
  if (unrestricted) return {};
  return {
    AND: [{ OR: [{ projectId: null }, { project: { is: projectVisibleToUser(userId) } }] }],
  };
}
const isUnrestricted = (ws: { effectiveRole: string; membership: { organizationRole: unknown } }) =>
  (ws.effectiveRole === 'OWNER' || ws.effectiveRole === 'PROJECT_MANAGER') &&
  !ws.membership.organizationRole;

async function meetingScopeFor(
  prisma: PrismaClient,
  input: { userId: string; workspaceId: string },
): Promise<Prisma.MeetingWhereInput> {
  const ws = await requireWorkspaceAccess(prisma, {
    userId: input.userId,
    workspaceId: input.workspaceId,
    capability: WorkspaceCapability.ViewWorkspace,
  });
  return meetingVisibility(input.userId, isUnrestricted(ws));
}

async function assertMeetingVisible(
  prisma: PrismaClient,
  input: { userId: string; workspaceId: string; meetingId: string },
): Promise<void> {
  const found = await prisma.meeting.findFirst({
    where: {
      id: input.meetingId,
      workspaceId: input.workspaceId,
      deletedAt: null,
      ...(await meetingScopeFor(prisma, input)),
    },
    select: { id: true },
  });
  if (!found) throw new AppError(404, 'MEETING_NOT_FOUND', 'That meeting does not exist');
}

export interface MeetingSummary {
  id: string;
  workspaceId: string | null;
  projectId: string | null;
  createdById: string;
  title: string;
  description: string | null;
  status: string;
  scheduledAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
  participantCount: number;
}

function toSummary(row: {
  id: string;
  workspaceId: string | null;
  projectId: string | null;
  createdById: string;
  title: string;
  description: string | null;
  status: string;
  scheduledAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  _count: { participants: number };
}): MeetingSummary {
  const { _count, ...m } = row;
  return {
    ...m,
    participantCount: _count.participants,
    scheduledAt: m.scheduledAt?.toISOString() ?? null,
    startedAt: m.startedAt?.toISOString() ?? null,
    endedAt: m.endedAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

type Input = { userId: string; workspaceId: string };

export interface MeetingServiceDependencies {
  meetingNotifier?: CollaborationEmailNotifier;
}

export function createMeetingService(
  prisma: PrismaClient = getPrismaClient(),
  deps: MeetingServiceDependencies = {},
) {
  const include = { _count: { select: { participants: true } } } as const;

  // Emails go out after the database write commits and never fail the request.
  async function notifyInvitees(
    meeting: {
      id: string;
      title: string;
      scheduledAt: Date | null;
      workspaceId: string | null;
      projectId: string | null;
    },
    organizerId: string,
    inviteeIds: string[],
  ): Promise<void> {
    if (!deps.meetingNotifier || !meeting.scheduledAt) return;
    try {
      const ids = [...new Set(inviteeIds)].filter((id) => id !== organizerId);
      if (ids.length === 0) return;
      const [organizer, invitees, workspace, project] = await Promise.all([
        prisma.user.findUnique({ where: { id: organizerId }, select: { name: true } }),
        prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, email: true, status: true, deletedAt: true },
        }),
        meeting.workspaceId
          ? prisma.workspace.findUnique({
              where: { id: meeting.workspaceId },
              select: { name: true },
            })
          : null,
        meeting.projectId
          ? prisma.project.findUnique({ where: { id: meeting.projectId }, select: { name: true } })
          : null,
      ]);
      if (!organizer) return;
      for (const invitee of invitees) {
        if (invitee.status !== 'ACTIVE' || invitee.deletedAt) continue;
        try {
          await deps.meetingNotifier.notifyMeetingInvitation({
            invitationId: `${meeting.id}:${invitee.id}`,
            invitationStatus: 'PENDING',
            inviteeId: invitee.id,
            inviteeEmail: invitee.email,
            inviteeName: invitee.name,
            organizerName: organizer.name,
            meetingTitle: meeting.title,
            startsAt: meeting.scheduledAt,
            meetingId: meeting.id,
            ...(meeting.workspaceId ? { workspaceId: meeting.workspaceId } : {}),
            ...(workspace ? { workspaceName: workspace.name } : {}),
            ...(project ? { projectName: project.name } : {}),
          });
        } catch {
          // Non-fatal: the invitation is already saved.
        }
      }
    } catch {
      // Non-fatal: the meeting change already committed.
    }
  }

  return {
    async create(
      input: Input & {
        title: string;
        description?: string | null;
        scheduledAt?: string | null;
        projectId?: string | null;
        calendarEventId?: string | null;
        participantIds?: string[];
      },
    ): Promise<MeetingSummary> {
      const ws = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      if (input.projectId) {
        await requireProjectAccess(prisma, {
          userId: input.userId,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          workspaceRole: ws.effectiveRole,
          capability: ProjectCapability.ViewProject,
        });
      }

      const meeting = await prisma.$transaction(async (tx) => {
        const created = await tx.meeting.create({
          data: {
            workspaceId: input.workspaceId,
            projectId: input.projectId ?? null,
            calendarEventId: input.calendarEventId ?? null,
            createdById: input.userId,
            title: input.title,
            description: input.description ?? null,
            scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          },
          include,
        });
        if (input.participantIds?.length) {
          await tx.meetingParticipant.createMany({
            data: input.participantIds.map((userId) => ({ meetingId: created.id, userId })),
            skipDuplicates: true,
          });
          for (const pid of input.participantIds) {
            await createNotification(tx, {
              userId: pid,
              type: 'MEETING_INVITE',
              title: `Meeting invitation: ${input.title}`,
              data: { workspaceId: input.workspaceId, meetingId: created.id },
            });
          }
        }
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'meeting.created',
          targetType: 'Meeting',
          targetId: created.id,
          metadata: { title: input.title },
        });
        return created;
      });
      await notifyInvitees(meeting, input.userId, input.participantIds ?? []);
      return toSummary(meeting);
    },

    async get(input: Input & { meetingId: string }): Promise<MeetingSummary> {
      const ws = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const m = await prisma.meeting.findFirst({
        where: {
          id: input.meetingId,
          workspaceId: input.workspaceId,
          deletedAt: null,
          ...meetingVisibility(input.userId, isUnrestricted(ws)),
        },
        include,
      });
      if (!m) throw new AppError(404, 'MEETING_NOT_FOUND', 'That meeting does not exist');
      return toSummary(m);
    },

    async list(
      input: Input & { cursor?: string; limit: number; status?: string; projectId?: string },
    ): Promise<{ items: MeetingSummary[]; nextCursor: string | null }> {
      const ws = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const meetings = await prisma.meeting.findMany({
        where: {
          workspaceId: input.workspaceId,
          deletedAt: null,
          ...meetingVisibility(input.userId, isUnrestricted(ws)),
          ...(input.status
            ? { status: input.status as 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED' }
            : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
        },
        orderBy: [{ scheduledAt: 'asc' }, { createdAt: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        include,
      });
      const hasMore = meetings.length > input.limit;
      const items = (hasMore ? meetings.slice(0, input.limit) : meetings).map(toSummary);
      return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
    },

    async update(
      input: Input & {
        meetingId: string;
        title?: string;
        description?: string | null;
        scheduledAt?: string | null;
        status?: string;
      },
    ): Promise<MeetingSummary> {
      const ws = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const m = await prisma.meeting.findFirst({
        where: {
          id: input.meetingId,
          workspaceId: input.workspaceId,
          deletedAt: null,
          ...(await meetingScopeFor(prisma, input)),
        },
      });
      if (!m) throw new AppError(404, 'MEETING_NOT_FOUND', 'That meeting does not exist');
      const isAdmin = ws.effectiveRole === 'OWNER' || ws.effectiveRole === 'PROJECT_MANAGER';
      if (m.createdById !== input.userId && !isAdmin)
        throw new AppError(403, 'MEETING_EDIT_FORBIDDEN', 'Only the creator or a manager can edit');

      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.meeting.update({
          where: { id: m.id },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.scheduledAt !== undefined
              ? { scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null }
              : {}),
            ...(input.status !== undefined
              ? { status: input.status as 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED' }
              : {}),
            ...(input.status === 'LIVE' && !m.startedAt ? { startedAt: new Date() } : {}),
            ...(input.status === 'ENDED' && !m.endedAt ? { endedAt: new Date() } : {}),
          },
          include,
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'meeting.updated',
          targetType: 'Meeting',
          targetId: m.id,
          metadata: { title: input.title ?? m.title },
        });
        return changed;
      });
      return toSummary(updated);
    },

    async delete(input: Input & { meetingId: string }): Promise<void> {
      const ws = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const m = await prisma.meeting.findFirst({
        where: {
          id: input.meetingId,
          workspaceId: input.workspaceId,
          deletedAt: null,
          ...(await meetingScopeFor(prisma, input)),
        },
      });
      if (!m) throw new AppError(404, 'MEETING_NOT_FOUND', 'That meeting does not exist');
      if (
        m.createdById !== input.userId &&
        ws.effectiveRole !== 'OWNER' &&
        ws.effectiveRole !== 'PROJECT_MANAGER'
      )
        throw new AppError(
          403,
          'MEETING_DELETE_FORBIDDEN',
          'Only the creator or a manager can delete',
        );
      await prisma.$transaction(async (tx) => {
        await tx.meeting.update({ where: { id: m.id }, data: { deletedAt: new Date() } });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'meeting.deleted',
          targetType: 'Meeting',
          targetId: m.id,
        });
      });
    },

    async addParticipant(
      input: Input & { meetingId: string; targetUserId: string },
    ): Promise<void> {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const m = await prisma.meeting.findFirst({
        where: {
          id: input.meetingId,
          workspaceId: input.workspaceId,
          deletedAt: null,
          ...(await meetingScopeFor(prisma, input)),
        },
      });
      if (!m) throw new AppError(404, 'MEETING_NOT_FOUND', 'That meeting does not exist');
      await prisma.$transaction(async (tx) => {
        await tx.meetingParticipant.upsert({
          where: { meetingId_userId: { meetingId: input.meetingId, userId: input.targetUserId } },
          create: { meetingId: input.meetingId, userId: input.targetUserId },
          update: {},
        });
        await createNotification(tx, {
          userId: input.targetUserId,
          type: 'MEETING_INVITE',
          title: `Meeting invitation: ${m.title}`,
          data: { workspaceId: input.workspaceId, meetingId: m.id },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'meeting.participant_added',
          targetType: 'Meeting',
          targetId: m.id,
          metadata: { participantUserId: input.targetUserId },
        });
      });
      await notifyInvitees(m, input.userId, [input.targetUserId]);
    },

    async removeParticipant(
      input: Input & { meetingId: string; targetUserId: string },
    ): Promise<void> {
      const ws = await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const m = await prisma.meeting.findFirst({
        where: {
          id: input.meetingId,
          workspaceId: input.workspaceId,
          deletedAt: null,
          ...(await meetingScopeFor(prisma, input)),
        },
        select: { id: true, createdById: true },
      });
      if (!m) throw new AppError(404, 'MEETING_NOT_FOUND', 'That meeting does not exist');
      const isManager = ws.effectiveRole === 'OWNER' || ws.effectiveRole === 'PROJECT_MANAGER';
      if (input.targetUserId !== input.userId && m.createdById !== input.userId && !isManager) {
        throw new AppError(403, 'MEETING_PARTICIPANT_FORBIDDEN', 'You cannot remove this participant');
      }
      await prisma.$transaction(async (tx) => {
        await tx.meetingParticipant.deleteMany({
          where: { meetingId: input.meetingId, userId: input.targetUserId },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'meeting.participant_removed',
          targetType: 'Meeting',
          targetId: m.id,
          metadata: { participantUserId: input.targetUserId },
        });
      });
    },

    async join(input: Input & { meetingId: string }): Promise<void> {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      const m = await prisma.meeting.findFirst({
        where: {
          id: input.meetingId,
          workspaceId: input.workspaceId,
          deletedAt: null,
          ...(await meetingScopeFor(prisma, input)),
        },
      });
      if (!m) throw new AppError(404, 'MEETING_NOT_FOUND', 'That meeting does not exist');
      if (m.status === 'CANCELLED')
        throw new AppError(409, 'MEETING_CANCELLED', 'This meeting has been cancelled');
      if (m.status === 'ENDED')
        throw new AppError(409, 'MEETING_ENDED', 'This meeting has ended and can no longer be joined');
      await prisma.$transaction(async (tx) => {
        await tx.meetingParticipant.upsert({
          where: { meetingId_userId: { meetingId: input.meetingId, userId: input.userId } },
          create: {
            meetingId: input.meetingId,
            userId: input.userId,
            status: 'JOINED',
            joinedAt: new Date(),
          },
          update: { status: 'JOINED', joinedAt: new Date(), leftAt: null },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'meeting.joined',
          targetType: 'Meeting',
          targetId: m.id,
        });
      });
    },

    async leave(input: Input & { meetingId: string }): Promise<void> {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      await assertMeetingVisible(prisma, input);
      await prisma.$transaction(async (tx) => {
        await tx.meetingParticipant.updateMany({
          where: { meetingId: input.meetingId, userId: input.userId },
          data: { status: 'LEFT', leftAt: new Date() },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId,
          actorId: input.userId,
          action: 'meeting.left',
          targetType: 'Meeting',
          targetId: input.meetingId,
        });
      });
    },

    async listParticipants(
      input: Input & { meetingId: string },
    ): Promise<
      Array<{ userId: string; status: string; joinedAt: string | null; leftAt: string | null }>
    > {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId,
        workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      await assertMeetingVisible(prisma, input);
      const participants = await prisma.meetingParticipant.findMany({
        where: { meetingId: input.meetingId },
        include: { user: { select: { id: true, name: true } } },
        orderBy: { joinedAt: 'asc' },
      });
      return participants.map((p) => ({
        userId: p.user.id,
        status: p.status as string,
        joinedAt: p.joinedAt?.toISOString() ?? null,
        leftAt: p.leftAt?.toISOString() ?? null,
      }));
    },
  };
}

export type MeetingService = ReturnType<typeof createMeetingService>;
