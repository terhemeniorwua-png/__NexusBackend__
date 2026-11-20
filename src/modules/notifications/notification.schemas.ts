import { z } from 'zod';

const uuid = z.string().uuid();

export const listNotificationsQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  type: z
    .enum([
      'MENTION',
      'TASK_ASSIGNED',
      'TASK_REASSIGNED',
      'TASK_SUBMITTED',
      'TASK_APPROVED',
      'CHANGES_REQUESTED',
      'COMMENT_REPLY',
      'MEMBERSHIP_CHANGED',
      'MEMBERSHIP_SUSPENDED',
      'MEMBERSHIP_RESTORED',
      'INVITATION_ACCEPTED',
      'JOIN_REQUEST_RECEIVED',
      'JOIN_REQUEST_APPROVED',
      'JOIN_REQUEST_REJECTED',
      'MEETING_INVITE',
      'MEETING_RESCHEDULED',
      'MEETING_CANCELLED',
      'PROJECT_UPDATE',
      'TASK_BLOCKER_REPORTED',
      'TASK_BLOCKER_RESOLVED',
      'TASK_DUE_SOON',
      'TASK_OVERDUE',
      'TASK_DECLINED',
      'INTEGRATION_RECONNECT_REQUIRED',
    ])
    .optional(),
});

export const markReadSchema = z.object({
  notificationIds: z.array(uuid).min(1).max(100),
});

export const updatePreferenceSchema = z
  .object({
    type: z.enum([
      'MENTION',
      'TASK_ASSIGNED',
      'TASK_REASSIGNED',
      'TASK_SUBMITTED',
      'TASK_APPROVED',
      'CHANGES_REQUESTED',
      'COMMENT_REPLY',
      'MEMBERSHIP_CHANGED',
      'MEMBERSHIP_SUSPENDED',
      'MEMBERSHIP_RESTORED',
      'INVITATION_ACCEPTED',
      'JOIN_REQUEST_RECEIVED',
      'JOIN_REQUEST_APPROVED',
      'JOIN_REQUEST_REJECTED',
      'MEETING_INVITE',
      'MEETING_RESCHEDULED',
      'MEETING_CANCELLED',
      'PROJECT_UPDATE',
      'TASK_BLOCKER_REPORTED',
      'TASK_BLOCKER_RESOLVED',
      'TASK_DUE_SOON',
      'TASK_OVERDUE',
      'TASK_DECLINED',
      'INTEGRATION_RECONNECT_REQUIRED',
    ]),
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
