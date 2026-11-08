import { z } from 'zod';

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  category: z.enum(['projects', 'tasks', 'documents', 'files', 'channels', 'meetings', 'all']).optional().default('all'),
  workspaceId: z.string().uuid().optional(),
}).strict();

export type SearchQuery = z.infer<typeof searchQuerySchema>;
