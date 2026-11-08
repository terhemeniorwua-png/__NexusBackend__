import { z } from 'zod';

const uuid = z.string().uuid();

export const calendarWorkspaceParamsSchema = z.object({ workspaceId: uuid });
export const eventParamsSchema = z.object({ workspaceId: uuid, eventId: uuid });

export const createEventSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5000).optional().nullable(),
  location: z.string().max(300).optional().nullable(),
  startAt: z.string().datetime({ offset: true }),
  endAt: z.string().datetime({ offset: true }),
  allDay: z.boolean().optional().default(false),
  status: z.enum(['CONFIRMED', 'TENTATIVE', 'CANCELLED']).optional().default('CONFIRMED'),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).optional().default('PUBLIC'),
  projectId: uuid.optional().nullable(),
  inviteeIds: z.array(uuid).max(100).optional().default([]),
}).strict().refine((v) => new Date(v.startAt) <= new Date(v.endAt), {
  message: 'startAt must be before or equal to endAt',
  path: ['endAt'],
});

export const updateEventSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(5000).optional().nullable(),
  location: z.string().max(300).optional().nullable(),
  startAt: z.string().datetime({ offset: true }).optional(),
  endAt: z.string().datetime({ offset: true }).optional(),
  allDay: z.boolean().optional(),
  status: z.enum(['CONFIRMED', 'TENTATIVE', 'CANCELLED']).optional(),
  visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
  projectId: uuid.optional().nullable(),
}).strict().refine(
  (v) => !v.startAt || !v.endAt || new Date(v.startAt) <= new Date(v.endAt),
  { message: 'startAt must be before or equal to endAt', path: ['endAt'] },
);

export const listEventsQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  startAfter: z.string().datetime({ offset: true }).optional(),
  startBefore: z.string().datetime({ offset: true }).optional(),
  projectId: uuid.optional(),
  status: z.enum(['CONFIRMED', 'TENTATIVE', 'CANCELLED']).optional(),
});

export const invitationSchema = z.object({ userId: uuid }).strict();
export const invitationParamsSchema = z.object({ workspaceId: uuid, eventId: uuid, userId: uuid });

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
