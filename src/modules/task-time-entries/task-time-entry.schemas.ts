import { z } from 'zod';

const uuid = z.string().uuid();

export const taskTimeEntryTaskParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
});

export const taskTimeEntryParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
  entryId: uuid,
});

export const createTaskTimeEntrySchema = z
  .object({
    startedAt: z.coerce.date(),
    durationMinutes: z.number().int().min(1).max(24 * 60),
    note: z.string().trim().max(2000).optional().nullable(),
  })
  .strict();

export const updateTaskTimeEntrySchema = z
  .object({
    startedAt: z.coerce.date().optional(),
    durationMinutes: z.number().int().min(1).max(24 * 60).optional(),
    note: z.string().trim().max(2000).optional().nullable(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to update',
  });

export type CreateTaskTimeEntryInput = z.infer<typeof createTaskTimeEntrySchema>;
export type UpdateTaskTimeEntryInput = z.infer<typeof updateTaskTimeEntrySchema>;
