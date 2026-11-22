import { NotificationType } from '@prisma/client';
import { z } from 'zod';

const uuid = z.string().uuid();
const notificationType = z.nativeEnum(NotificationType);

export const listNotificationsQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  type: notificationType.optional(),
});

export const markReadSchema = z.object({
  notificationIds: z.array(uuid).min(1).max(100),
});

export const updatePreferenceSchema = z
  .object({
    type: notificationType,
    inAppEnabled: z.boolean().optional(),
    emailEnabled: z.boolean().optional(),
  })
  .refine((value) => value.inAppEnabled !== undefined || value.emailEnabled !== undefined, {
    message: 'Provide at least one channel preference',
  });

export const preferenceParamsSchema = z.object({
  workspaceId: uuid,
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
export type MarkReadInput = z.infer<typeof markReadSchema>;
export type UpdatePreferenceInput = z.infer<typeof updatePreferenceSchema>;
