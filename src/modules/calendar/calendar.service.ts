import type { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { recordAuditEvent } from '../../services/audit';
import { createNotification } from '../../services/notifications';
import { AppError } from '../../utils/errors';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { ProjectCapability, requireProjectAccess } from '../authorization/project.policy';
import { projectVisibleToUser } from '../projects/project-visibility';

export interface EventSummary {
  id: string;
  workspaceId: string | null;
  projectId: string | null;
  createdById: string;
  title: string;
  description: string | null;
  location: string | null;
  startAt: string;
  endAt: string;
  allDay: boolean;
  status: string;
  visibility: string;
  createdAt: string;
  updatedAt: string;
}

function toSummary(row: {
  id: string; workspaceId: string | null; projectId: string | null;
  createdById: string; title: string; description: string | null;
  location: string | null; startAt: Date; endAt: Date; allDay: boolean;
  status: string; visibility: string; createdAt: Date; updatedAt: Date;
}): EventSummary {
  return {
    ...row,
    startAt: row.startAt.toISOString(),
    endAt: row.endAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type Input = { userId: string; workspaceId: string };

/** Events on projects the caller cannot see are hidden. Unrestricted legacy managers bypass. */
async function eventScope(prisma: PrismaClient, input: { userId: string; workspaceId: string }): Promise<Prisma.CalendarEventWhereInput> {
  const ws = await requireWorkspaceAccess(prisma, {
    userId: input.userId, workspaceId: input.workspaceId,
    capability: WorkspaceCapability.ViewWorkspace,
  });
  const unrestricted = (ws.effectiveRole === 'OWNER' || ws.effectiveRole === 'PROJECT_MANAGER') && !ws.membership.organizationRole;
  if (unrestricted) return {};
  const visible = await prisma.project.findMany({
    where: { workspaceId: input.workspaceId, AND: [projectVisibleToUser(input.userId)] },
    select: { id: true },
  });
  return { OR: [{ projectId: null }, { projectId: { in: visible.map((p) => p.id) } }] };
}

async function assertEventVisible(prisma: PrismaClient, input: { userId: string; workspaceId: string; eventId: string }): Promise<void> {
  const found = await prisma.calendarEvent.findFirst({
    where: { id: input.eventId, workspaceId: input.workspaceId, deletedAt: null, ...(await eventScope(prisma, input)) },
    select: { id: true },
  });
  if (!found) throw new AppError(404, 'EVENT_NOT_FOUND', 'That event does not exist');
}


export function createCalendarService(prisma: PrismaClient = getPrismaClient()) {
  return {
    async create(
      input: Input & {
        title: string; description?: string | null; location?: string | null;
        startAt: string; endAt: string; allDay: boolean;
        status: string; visibility: string; projectId?: string | null;
        inviteeIds?: string[];
      },
    ): Promise<EventSummary> {
      const ws = await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });
      if (input.projectId) {
        await requireProjectAccess(prisma, {
          userId: input.userId, workspaceId: input.workspaceId, projectId: input.projectId,
          workspaceRole: ws.effectiveRole, capability: ProjectCapability.ViewProject,
        });
      }

      const event = await prisma.$transaction(async (tx) => {
        const created = await tx.calendarEvent.create({
          data: {
            workspaceId: input.workspaceId,
            projectId: input.projectId ?? null,
            createdById: input.userId,
            title: input.title,
            description: input.description ?? null,
            location: input.location ?? null,
            startAt: new Date(input.startAt),
            endAt: new Date(input.endAt),
            allDay: input.allDay,
            status: input.status as 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED',
            visibility: input.visibility as 'PUBLIC' | 'PRIVATE',
          },
        });

        if (input.inviteeIds && input.inviteeIds.length > 0) {
          await tx.eventInvitation.createMany({
            data: input.inviteeIds.map((userId) => ({ eventId: created.id, userId })),
            skipDuplicates: true,
          });
          for (const inviteeId of input.inviteeIds) {
            await createNotification(tx, {
              userId: inviteeId, type: 'MEETING_INVITE',
              title: `Event invitation: ${input.title}`,
              body: input.description ?? undefined,
              link: undefined,
              data: { workspaceId: input.workspaceId, eventId: created.id },
            });
          }
        }

        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId, actorId: input.userId,
          action: 'calendar.event_created', targetType: 'CalendarEvent', targetId: created.id,
          metadata: { title: input.title, startAt: input.startAt, endAt: input.endAt },
        });
        return created;
      });

      return toSummary(event);
    },

    async get(input: Input & { eventId: string }): Promise<EventSummary> {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const event = await prisma.calendarEvent.findFirst({
        where: { id: input.eventId, workspaceId: input.workspaceId, deletedAt: null, ...(await eventScope(prisma, input)) },
      });
      if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'That event does not exist');
      return toSummary(event);
    },

    async list(
      input: Input & {
        cursor?: string; limit: number;
        startAfter?: string; startBefore?: string;
        projectId?: string; status?: string;
      },
    ): Promise<{ items: EventSummary[]; nextCursor: string | null }> {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const events = await prisma.calendarEvent.findMany({
        where: {
          workspaceId: input.workspaceId, deletedAt: null,
          ...(await eventScope(prisma, input)),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.status ? { status: input.status as 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED' } : {}),
          ...(input.startAfter ? { startAt: { gte: new Date(input.startAfter) } } : {}),
          ...(input.startBefore ? { startAt: { lte: new Date(input.startBefore) } } : {}),
        },
        orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });

      const hasMore = events.length > input.limit;
      const items = (hasMore ? events.slice(0, input.limit) : events).map(toSummary);
      const nextCursor = hasMore ? items[items.length - 1]?.id ?? null : null;
      return { items, nextCursor };
    },

    async update(
      input: Input & { eventId: string; title?: string; description?: string | null;
        location?: string | null; startAt?: string; endAt?: string; allDay?: boolean;
        status?: string; visibility?: string; projectId?: string | null },
    ): Promise<EventSummary> {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const event = await prisma.calendarEvent.findFirst({
        where: { id: input.eventId, workspaceId: input.workspaceId, deletedAt: null, ...(await eventScope(prisma, input)) },
      });
      if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'That event does not exist');

      const isCreator = event.createdById === input.userId;
      const workspace = await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ManageMembers,
      });
      const isAdmin = workspace.effectiveRole === 'OWNER' || workspace.effectiveRole === 'PROJECT_MANAGER';
      if (!isCreator && !isAdmin) {
        throw new AppError(403, 'EVENT_EDIT_FORBIDDEN', 'Only the creator or a manager can edit this event');
      }

      if (input.projectId && input.projectId !== event.projectId) {
        await requireProjectAccess(prisma, {
          userId: input.userId, workspaceId: input.workspaceId, projectId: input.projectId,
          workspaceRole: workspace.effectiveRole, capability: ProjectCapability.ViewProject,
        });
      }

      const updated = await prisma.$transaction(async (tx) => {
        const changed = await tx.calendarEvent.update({
          where: { id: event.id },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.location !== undefined ? { location: input.location } : {}),
            ...(input.startAt !== undefined ? { startAt: new Date(input.startAt) } : {}),
            ...(input.endAt !== undefined ? { endAt: new Date(input.endAt) } : {}),
            ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
            ...(input.status !== undefined ? { status: input.status as 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED' } : {}),
            ...(input.visibility !== undefined ? { visibility: input.visibility as 'PUBLIC' | 'PRIVATE' } : {}),
            ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId, actorId: input.userId,
          action: 'calendar.event_updated', targetType: 'CalendarEvent', targetId: event.id,
          metadata: { title: input.title ?? event.title },
        });
        return changed;
      });
      return toSummary(updated);
    },

    async cancel(input: Input & { eventId: string }): Promise<void> {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const event = await prisma.calendarEvent.findFirst({
        where: { id: input.eventId, workspaceId: input.workspaceId, deletedAt: null, ...(await eventScope(prisma, input)) },
      });
      if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'That event does not exist');

      await prisma.$transaction(async (tx) => {
        await tx.calendarEvent.update({
          where: { id: event.id },
          data: { status: 'CANCELLED' },
        });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId, actorId: input.userId,
          action: 'calendar.event_cancelled', targetType: 'CalendarEvent', targetId: event.id,
        });
      });
    },

    async delete(input: Input & { eventId: string }): Promise<void> {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const event = await prisma.calendarEvent.findFirst({
        where: { id: input.eventId, workspaceId: input.workspaceId, deletedAt: null, ...(await eventScope(prisma, input)) },
      });
      if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'That event does not exist');

      await prisma.$transaction(async (tx) => {
        await tx.calendarEvent.update({ where: { id: event.id }, data: { deletedAt: new Date() } });
        await recordAuditEvent(tx, {
          workspaceId: input.workspaceId, actorId: input.userId,
          action: 'calendar.event_deleted', targetType: 'CalendarEvent', targetId: event.id,
        });
      });
    },

    async addInvitee(
      input: Input & { eventId: string; targetUserId: string },
    ): Promise<void> {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      const event = await prisma.calendarEvent.findFirst({
        where: { id: input.eventId, workspaceId: input.workspaceId, deletedAt: null, ...(await eventScope(prisma, input)) },
      });
      if (!event) throw new AppError(404, 'EVENT_NOT_FOUND', 'That event does not exist');

      await prisma.eventInvitation.upsert({
        where: { eventId_userId: { eventId: input.eventId, userId: input.targetUserId } },
        create: { eventId: input.eventId, userId: input.targetUserId },
        update: {},
      });

      await createNotification(prisma, {
        userId: input.targetUserId, type: 'MEETING_INVITE',
        title: `Event invitation: ${event.title}`,
        data: { workspaceId: input.workspaceId, eventId: event.id },
      });
    },

    async removeInvitee(
      input: Input & { eventId: string; targetUserId: string },
    ): Promise<void> {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      await assertEventVisible(prisma, input);

      await prisma.eventInvitation.deleteMany({
        where: { eventId: input.eventId, userId: input.targetUserId },
      });
    },

    async respondToInvitation(
      input: Input & { eventId: string; status: 'ACCEPTED' | 'DECLINED' | 'TENTATIVE' },
    ): Promise<void> {
      const invitation = await prisma.eventInvitation.findUnique({
        where: { eventId_userId: { eventId: input.eventId, userId: input.userId } },
        include: { event: true },
      });
      if (!invitation) throw new AppError(404, 'INVITATION_NOT_FOUND', 'You are not invited to this event');

      await prisma.eventInvitation.update({
        where: { id: invitation.id },
        data: { status: input.status },
      });
    },

    async listInvitations(
      input: Input & { eventId: string },
    ): Promise<Array<{ userId: string; status: string; createdAt: string }>> {
      await requireWorkspaceAccess(prisma, {
        userId: input.userId, workspaceId: input.workspaceId,
        capability: WorkspaceCapability.ViewWorkspace,
      });

      await assertEventVisible(prisma, input);

      const invitations = await prisma.eventInvitation.findMany({
        where: { eventId: input.eventId },
        include: { user: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      });

      return invitations.map((inv) => ({
        userId: inv.user.id,
        status: inv.status as string,
        createdAt: inv.createdAt.toISOString(),
      }));
    },
  };
}

export type CalendarService = ReturnType<typeof createCalendarService>;
