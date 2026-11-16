import type { Notification, NotificationType, Prisma, PrismaClient } from '@prisma/client';
import { emitToUser } from '../realtime/io-registry';

/**
 * In-app notifications.
 *
 * A notification tells a member that something happened inside a workspace.
 * The rows are written in the same transaction as the change that caused
 * them, so a member never sees a notification for a change that was rolled
 * back.
 *
 * Preference rules (existing): when `data.workspaceId` is provided and the
 * member has `inAppEnabled === false` for (workspace,user,type), no in-app
 * notification row is created. Message unread counts are tracked separately via
 * message read receipts and are not stored as general notifications.
 */

export type NotificationClient = PrismaClient | Prisma.TransactionClient;

export interface NotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | undefined;
  link?: string | undefined;
  data?: Record<string, unknown> | undefined;
}

export async function createNotification(
  client: NotificationClient,
  input: NotificationInput,
): Promise<Notification | null> {
  const workspaceId = input.data?.workspaceId;
  if (typeof workspaceId === 'string') {
    const preference = await client.notificationPreference.findUnique({
      where: {
        workspaceId_userId_type: { workspaceId, userId: input.userId, type: input.type },
      },
      select: { inAppEnabled: true },
    });
    if (preference?.inAppEnabled === false) return null;
  }

  const notification = await client.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      ...(input.link ? { link: input.link } : {}),
      ...(input.data ? { data: input.data as Prisma.InputJsonValue } : {}),
    },
  });

  // Realtime delivery to the recipient's private room (best-effort). This does
  // not affect message unread counts, which remain channel read-receipt based.
  emitToUser(input.userId, 'notification.created', {
    notification: {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      link: notification.link,
      data: (notification.data as Record<string, unknown> | null) ?? null,
      readAt: notification.readAt?.toISOString() ?? null,
      createdAt: notification.createdAt.toISOString(),
    },
  });

  return notification;
}

