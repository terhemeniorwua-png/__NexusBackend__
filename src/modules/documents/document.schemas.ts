import { z } from 'zod';

const uuid = z.string().uuid();

export const documentWorkspaceParamsSchema = z.object({ workspaceId: uuid });
export const documentParamsSchema = z.object({ workspaceId: uuid, documentId: uuid });
export const documentCommentParamsSchema = z.object({
  workspaceId: uuid,
  documentId: uuid,
  commentId: uuid,
});

export const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(300),
  content: z.string().max(500_000).optional().default(''),
  projectId: uuid.optional().nullable(),
  taskId: uuid.optional().nullable(),
}).strict();

export const updateDocumentSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  content: z.string().max(500_000).optional(),
}).strict().refine((v) => v.title !== undefined || v.content !== undefined, {
  message: 'Provide at least title or content',
});

export const listDocumentsQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  projectId: uuid.optional(),
  taskId: uuid.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

export const createDocumentCommentSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
}).strict();

export const updateDocumentCommentSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
}).strict();

export type CreateDocumentInput = z.infer<typeof createDocumentSchema>;
export type UpdateDocumentInput = z.infer<typeof updateDocumentSchema>;
export type ListDocumentsQuery = z.infer<typeof listDocumentsQuerySchema>;
