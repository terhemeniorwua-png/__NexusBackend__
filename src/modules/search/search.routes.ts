import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  recentSearchesQuerySchema,
  searchQuerySchema,
  searchSuggestionsQuerySchema,
  type RecentSearchesQuery,
  type SearchQuery,
  type SearchSuggestionsQuery,
} from './search.schemas';
import { createSearchService } from './search.service';

export interface SearchRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createSearchService>;
}
function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in');
  return req.auth.userId;
}

export function createSearchRouter({
  config,
  service = createSearchService(),
}: SearchRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get(
    '/',
    requireAuth,
    requireActive,
    validate({ query: searchQuerySchema }),
    async (req, res) => {
      const query = req.validated!.query as SearchQuery;
      const page = await service.searchPage(userId(req), {
        query: query.q,
        category: query.category,
        workspaceId: query.workspaceId,
        page: query.page,
        limit: query.limit,
        sort: query.sort,
      });
      sendSuccess(res, page.results, 200, {
        total: page.total,
        page: page.page,
        limit: page.limit,
        hasMore: page.hasMore,
        category: page.category,
      });
    },
  );

  router.get(
    '/suggestions',
    requireAuth,
    requireActive,
    validate({ query: searchSuggestionsQuerySchema }),
    async (req, res) => {
      const query = req.validated!.query as SearchSuggestionsQuery;
      sendSuccess(res, await service.suggestions(userId(req), query.q, query.workspaceId));
    },
  );

  router.get(
    '/recent',
    requireAuth,
    requireActive,
    validate({ query: recentSearchesQuerySchema }),
    async (req, res) => {
      const query = req.validated!.query as RecentSearchesQuery;
      sendSuccess(res, await service.recentSearches(userId(req), query.workspaceId));
    },
  );

  router.delete(
    '/recent',
    requireAuth,
    requireActive,
    validate({ query: recentSearchesQuerySchema }),
    async (req, res) => {
      const query = req.validated!.query as RecentSearchesQuery;
      const deleted = await service.clearRecentSearches(userId(req), query.workspaceId);
      sendSuccess(res, { deleted });
    },
  );

  return router;
}
