import { z } from 'zod';

const uuid = z.string().uuid();

export const taskWorkDocumentTaskParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
});

export const taskWorkDocumentParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
  documentId: uuid,
});

export const taskWorkDocumentVersionParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
  documentId: uuid,
  version: z.coerce.number().int().min(1),
});

export const listTaskWorkDocumentsQuerySchema = z.object({}).strict();

const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2 MB JSON payload limit

export const createTaskWorkDocumentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    content: z.unknown().optional(),
  })
  .strict();

export const updateTaskWorkDocumentSchema = z
  .object({
    baseVersion: z.number().int().min(1),
    content: z.unknown(),
    title: z.string().trim().min(1).max(200).optional(),
    mode: z.enum(['autosave', 'manual']).optional().default('manual'),
  })
  .strict();

export const restoreTaskWorkDocumentSchema = z.object({}).strict();

export type CreateTaskWorkDocumentInput = z.infer<typeof createTaskWorkDocumentSchema>;
export type UpdateTaskWorkDocumentInput = z.infer<typeof updateTaskWorkDocumentSchema>;

export { MAX_CONTENT_BYTES };
