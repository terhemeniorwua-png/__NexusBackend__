import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { loadEnv } from '../../config/env';
import { createRequireAuth } from '../../middleware/authenticate';
import { getPrismaClient } from '../../db/prisma';
import { requireWorkspaceAccess, WorkspaceCapability, userWorkspaceAccessContext } from '../../modules/workspaces/authorization';
import { searchExternalFiles, importExternalFile } from './service';

export const externalFilesRouter = Router();

const config = loadEnv();
const requireAuth = createRequireAuth(config);

type AuthRequest = Request & { auth?: { userId: string; sessionId: string; authMethod: 'password' | 'social' | 'sso' | 'break_glass'; authMethodExpiresAt?: Date | null } };

externalFilesRouter.get('/external-search', requireAuth, (async (req: AuthRequest, res, next) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      return;
    }
    const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    res.json(await searchExternalFiles(userId, q));
  } catch (e) {
    next(e);
  }
}) as RequestHandler);

externalFilesRouter.post('/import', requireAuth, (async (req: AuthRequest, res, next) => {
  try {
    const userId = req.auth?.userId;
    if (!userId) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      return;
    }
    const body = z
      .object({
        workspaceId: z.string().min(1),
        provider: z.enum(['google_drive', 'onedrive', 'dropbox']),
        externalId: z.string().min(1),
      })
      .strict()
      .parse(req.body);

    if (!req.auth) {
      res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
      return;
    }
    await requireWorkspaceAccess(getPrismaClient(), {
      userId,
      workspaceId: body.workspaceId,
      capability: WorkspaceCapability.UpdateWorkspace,
      context: userWorkspaceAccessContext(req.auth),
    });

    res.status(201).json(await importExternalFile(userId, body.workspaceId, body.provider, body.externalId));
  } catch (e) {
    next(e);
  }
}) as RequestHandler);
