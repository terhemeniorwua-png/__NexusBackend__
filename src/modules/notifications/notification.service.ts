import type { PrismaClient, NotificationType } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';

export interface NotificationSummary {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

type Input = { userId: string };

export function createNotificationService(prisma: PrismaClient = getPrismaClient()) {
  return {
    async list(
      input: Input & {
        cursor?: string;
        limit: number;
        unreadOnly?: boolean;
        type?: NotificationType;
      },
    ): Promise<{ items: NotificationSummary[]; nextCursor: string | null; unreadCount: number }> {
      const [notifications, unreadCount] = await Promise.all([
        prisma.notification.findMany({
          where: {
            userId: input.userId,
            ...(input.unreadOnly ? { readAt: null } : {}),
            ...(input.type ? { type: input.type } : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          select: {
            id: true,
            type: true,
            title: true,
            body: true,
            link: true,
            data: true,
            readAt: true,
            createdAt: true,
          },
        }),
        prisma.notification.count({
          where: { userId: input.userId, readAt: null },
        }),
      ]);

      const hasMore = notifications.length > input.limit;
      const items = (hasMore ? notifications.slice(0, input.limit) : notifications).map((n) => ({
        ...n,
        type: n.type as string,
        data: n.data as Record<string, unknown> | null,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      }));
      const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

      return { items, nextCursor, unreadCount };
    },

    async markRead(input: Input & { notificationIds: string[] }): Promise<void> {
      await prisma.notification.updateMany({
        where: {
          id: { in: input.notificationIds },
          userId: input.userId,
        },
        data: { readAt: new Date() },
      });
    },

    async markAllRead(input: Input): Promise<void> {
      await prisma.notification.updateMany({
        where: {
          userId: input.userId,
          readAt: null,
        },
        data: { readAt: new Date() },
      });
    },

    async getUnreadCount(input: Input): Promise<{ unreadCount: number }> {
      const unreadCount = await prisma.notification.count({
        where: { userId: input.userId, readAt: null },
      });
      return { unreadCount };
    },

    async listPreferences(
      input: Input & { workspaceId: string },
    ): Promise<Array<{ type: string; inAppEnabled: boolean; emailEnabled: boolean }>> {
      const prefs = await prisma.notificationPreference.findMany({
        where: { workspaceId: input.workspaceId, userId: input.userId },
        select: { type: true, inAppEnabled: true, emailEnabled: true },
        orderBy: { type: 'asc' },
      });
      return prefs.map((p) => ({
        type: p.type as string,
        inAppEnabled: p.inAppEnabled,
        emailEnabled: p.emailEnabled,
      }));
    },

    async updatePreference(
      input: Input & {
        workspaceId: string;
        type: NotificationType;
        inAppEnabled?: boolean;
        emailEnabled?: boolean;
      },
    ): Promise<void> {
      // Verify the user is a member of the workspace
      const membership = await prisma.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: input.workspaceId, userId: input.userId },
        },
        select: { id: true },
      });
      if (!membership) {
        throw new AppError(
          403,
          'WORKSPACE_ACCESS_DENIED',
          'You are not a member of this workspace',
        );
      }

      const existing = await prisma.notificationPreference.findUnique({
        where: {
          workspaceId_userId_type: {
            workspaceId: input.workspaceId,
            userId: input.userId,
            type: input.type,
          },
        },
        select: { inAppEnabled: true, emailEnabled: true },
      });

      await prisma.notificationPreference.upsert({
        where: {
          workspaceId_userId_type: {
            workspaceId: input.workspaceId,
            userId: input.userId,
            type: input.type,
          },
        },
        create: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          type: input.type,
          inAppEnabled: input.inAppEnabled ?? existing?.inAppEnabled ?? true,
          emailEnabled: input.emailEnabled ?? existing?.emailEnabled ?? true,
        },
        update: {
          ...(input.inAppEnabled !== undefined ? { inAppEnabled: input.inAppEnabled } : {}),
          ...(input.emailEnabled !== undefined ? { emailEnabled: input.emailEnabled } : {}),
        },
      });
    },

    async listActivity(
      input: Input & { workspaceId: string; cursor?: string; limit: number },
    ): Promise<{
      items: Array<{
        id: string;
        action: string;
        actorId: string | null;
        targetType: string;
        targetId: string;
        metadata: Record<string, unknown> | null;
        createdAt: string;
      }>;
      nextCursor: string | null;
    }> {
      const entries = await prisma.auditLog.findMany({
        where: { workspaceId: input.workspaceId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        select: {
          id: true,
          action: true,
          actorId: true,
          targetType: true,
          targetId: true,
          metadata: true,
          createdAt: true,
        },
      });

      const hasMore = entries.length > input.limit;
      const items = (hasMore ? entries.slice(0, input.limit) : entries).map((e) => ({
        ...e,
        metadata: e.metadata as Record<string, unknown> | null,
        createdAt: e.createdAt.toISOString(),
      }));
      const nextCursor = hasMore ? (items[items.length - 1]?.id ?? null) : null;

      return { items, nextCursor };
    },
  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
