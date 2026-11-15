import { z } from 'zod';

const uuid = z.string().uuid();

export const taskBlockerTaskParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
});

export const taskBlockerParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
  blockerId: uuid,
});

export const createTaskBlockerSchema = z
  .object({
    description: z.string().trim().min(1).max(2000),
    notifyUserId: uuid.optional().nullable(),
  })
  .strict();

export const resolveTaskBlockerSchema = z.object({}).strict();

export type CreateTaskBlockerInput = z.infer<typeof createTaskBlockerSchema>;
