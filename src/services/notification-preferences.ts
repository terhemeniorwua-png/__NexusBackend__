import type { NotificationType, Prisma, PrismaClient } from '@prisma/client';

/**
 * Notification channel preferences.
 *
 * `NotificationPreference` stores one row per member, workspace and
 * notification type. In-app delivery and email delivery are independent
 * channels: a member can keep an in-app notification while turning off the
 * matching email.
 *
 * A missing row means the default, which is enabled. That keeps behaviour
 * unchanged for members who have never opened their preferences and for
 * recipients that are not workspace members yet (for example an applicant
 * whose join request was declined).
 */

export type NotificationPreferenceClient = PrismaClient | Prisma.TransactionClient;

export interface EmailPreferenceLookup {
  workspaceId: string;
  userId: string;
  type: NotificationType;
}

export async function isEmailNotificationEnabled(
  client: NotificationPreferenceClient,
  input: EmailPreferenceLookup,
): Promise<boolean> {
  const preference = await client.notificationPreference.findUnique({
    where: {
      workspaceId_userId_type: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        type: input.type,
      },
    },
    select: { emailEnabled: true },
  });

  return preference?.emailEnabled ?? true;
}
