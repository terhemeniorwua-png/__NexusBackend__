import { z } from 'zod';
const uuid = z.string().uuid();

export const meetingWorkspaceParams = z.object({ workspaceId: uuid });
export const meetingParamsSchema = z.object({ workspaceId: uuid, meetingId: uuid });
export const participantParamsSchema = z.object({ workspaceId: uuid, meetingId: uuid, userId: uuid });

export const createMeetingSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5000).optional().nullable(),
  scheduledAt: z.string().datetime({ offset: true }).optional().nullable(),
  projectId: uuid.optional().nullable(),
  calendarEventId: uuid.optional().nullable(),
  participantIds: z.array(uuid).max(100).optional().default([]),
}).strict();

export const updateMeetingSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(5000).optional().nullable(),
  scheduledAt: z.string().datetime({ offset: true }).optional().nullable(),
  status: z.enum(['SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED']).optional(),
}).strict();

export const listMeetingsQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED']).optional(),
  projectId: uuid.optional(),
});

export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;
export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;
export type ListMeetingsQuery = z.infer<typeof listMeetingsQuerySchema>;
