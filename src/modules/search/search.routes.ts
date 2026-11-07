import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { searchQuerySchema, type SearchQuery } from './search.schemas';
import { createSearchService } from './search.service';

export interface SearchRouterOptions { config: AppConfig; service?: ReturnType<typeof createSearchService> }
function userId(req: Request): string { if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in'); return req.auth.userId; }

export function createSearchRouter({ config, service = createSearchService() }: SearchRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get('/', requireAuth, requireActive, validate({ query: searchQuerySchema }), async (req, res) => {
    const query = req.validated!.query as SearchQuery;
    sendSuccess(res, await service.search(userId(req), query.q, query.category, query.workspaceId));
  });

  return router;
}
