import { Router } from 'express';
import { z } from 'zod';
// ADJUST these two imports to your project:
import { requirePermission } from '../../middleware/rbac';
import { searchExternalFiles, importExternalFile } from './service';

export const externalFilesRouter = Router();

externalFilesRouter.get('/external-search', requirePermission('files:read'), async (req: any, res, next) => {
  try {
    const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    res.json(await searchExternalFiles(req.user.id, q));
  } catch (e) { next(e); }
});

externalFilesRouter.post('/import', requirePermission('files:create'), async (req: any, res, next) => {
  try {
    const body = z
      .object({
        workspaceId: z.string().min(1),
        provider: z.enum(['google_drive', 'onedrive', 'dropbox']),
        externalId: z.string().min(1),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(await importExternalFile(req.user.id, body.workspaceId, body.provider, body.externalId));
  } catch (e) { next(e); }
});
