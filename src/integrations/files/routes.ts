import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from './';
import { prisma } from './';
import { requireWorkspaceAccess } from '../../modules/authorization/workspace.policy';
import { searchExternalFiles, importExternalFile } from './service';

export const externalFilesRouter = Router();

externalFilesRouter.get('/external-search', authenticate, async (req: any, res, next) => {
  try {
    const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    res.json(await searchExternalFiles(req.user.id, q));
  } catch (e) { next(e); }
});

externalFilesRouter.post('/import', authenticate, async (req: any, res, next) => {
  try {
    const body = z
      .object({
        workspaceId: z.string().min(1),
        provider: z.enum(['google_drive', 'onedrive', 'dropbox']),
        externalId: z.string().min(1),
      })
      .strict()
      .parse(req.body);

    await requireWorkspaceAccess(prisma, {
      userId: req.user.id,
      workspaceId: body.workspaceId,
      capability: 'REPLACE_WITH_REAL_CAPABILITY' as any,
    });

    res.status(201).json(await importExternalFile(req.user.id, body.workspaceId, body.provider, body.externalId));
  } catch (e) { next(e); }
});
