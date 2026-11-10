import { z } from 'zod';

const uuid = z.string().uuid();

export const SEARCH_CATEGORY_VALUES = [
  'all',
  'people',
  'workspaces',
  'teams',
  'departments',
  'projects',
  'tasks',
  'messages',
  'conversations',
  'files',
  'documents',
  'meetings',
  'channels',
  'announcements',
] as const;

export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    category: z.enum(SEARCH_CATEGORY_VALUES).optional().default('all'),
    workspaceId: uuid.optional(),
    page: z.coerce.number().int().min(1).max(100).optional().default(1),
    limit: z.coerce.number().int().min(1).max(50).optional().default(25),
    sort: z.enum(['relevance', 'recent']).optional().default('relevance'),
  })
  .strict();

export const searchSuggestionsQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200),
    workspaceId: uuid.optional(),
  })
  .strict();

export const recentSearchesQuerySchema = z
  .object({
    workspaceId: uuid.optional(),
  })
  .strict();

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchSuggestionsQuery = z.infer<typeof searchSuggestionsQuerySchema>;
export type RecentSearchesQuery = z.infer<typeof recentSearchesQuerySchema>;
