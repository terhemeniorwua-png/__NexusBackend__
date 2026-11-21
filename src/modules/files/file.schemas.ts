import { z } from 'zod';

const uuid = z.string().uuid();

export const fileWorkspaceParamsSchema = z.object({ workspaceId: uuid });
export const fileProjectParamsSchema = z.object({ workspaceId: uuid, projectId: uuid });
export const fileTaskParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  taskId: uuid,
});
export const fileParamsSchema = z.object({
  workspaceId: uuid,
  fileId: uuid,
});
export const fileProjectFileParamsSchema = z.object({
  workspaceId: uuid,
  projectId: uuid,
  fileId: uuid,
});
export const fileVersionParamsSchema = fileParamsSchema.extend({ versionId: uuid });
export const fileFeedbackParamsSchema = fileVersionParamsSchema.extend({ feedbackId: uuid });

export const listFilesQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  projectId: uuid.optional(),
  taskId: uuid.optional(),
});

export const ALLOWED_MIME_TYPES = [
  // Documents
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Text
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  // Images
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Archives
  'application/zip',
  // Video & Audio
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/ogg',
] as const;

export const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

export const listVersionsQuerySchema = z.object({
  cursor: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const feedbackBody = z
  .string()
  .min(1)
  .max(4000)
  .refine((value) => value.trim().length > 0, { message: 'Feedback cannot be blank' });

export const createFeedbackSchema = z.object({ body: feedbackBody });
export const updateFeedbackSchema = z.object({ body: feedbackBody });

export type ListFilesQuery = z.infer<typeof listFilesQuerySchema>;
export type ListVersionsQuery = z.infer<typeof listVersionsQuerySchema>;
export type CreateFeedbackInput = z.infer<typeof createFeedbackSchema>;
export type UpdateFeedbackInput = z.infer<typeof updateFeedbackSchema>;
