import type { NotificationType, Prisma, PrismaClient } from '@prisma/client';

/**
 * In-app notifications.
 *
 * A notification tells a member that something happened inside a workspace.
 * The rows are written in the same transaction as the change that caused
 * them, so a member never sees a notification for a change that was rolled
 * back.
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
): Promise<void> {
  const workspaceId = input.data?.workspaceId;
  if (typeof workspaceId === 'string') {
    const preference = await client.notificationPreference.findUnique({
      where: {
        workspaceId_userId_type: { workspaceId, userId: input.userId, type: input.type },
      },
      select: { inAppEnabled: true },
    });
    if (preference?.inAppEnabled === false) return;
  }

  await client.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      ...(input.link ? { link: input.link } : {}),
      ...(input.data ? { data: input.data as Prisma.InputJsonValue } : {}),
    },
  });
}
