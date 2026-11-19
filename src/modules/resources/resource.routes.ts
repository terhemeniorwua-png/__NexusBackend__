import type { z } from 'zod';
import { Router, type Request } from 'express';
import multer from 'multer';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { createS3CompatibleObjectStorage } from '../../services/storage/private-object-storage';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  RESOURCE_BATCH_MAX_FILES,
  RESOURCE_BATCH_MAX_TOTAL_BYTES,
  bookmarkSchema,
  createFolderSchema,
  dashboardPreferenceSchema,
  folderUploadMetaSchema,
  listBookmarksQuerySchema,
  listFoldersQuerySchema,
  listRecentQuerySchema,
  listResourceFilesQuerySchema,
  moveFolderSchema,
  moveResourceFileSchema,
  projectBookmarkParamsSchema,
  projectFolderParamsSchema,
  projectResourceFileParamsSchema,
  projectScopeParamsSchema,
  recordRecentSchema,
  renameFolderSchema,
  renameResourceFileSchema,
  updateBookmarkSchema,
  workspaceScopeParamsSchema,
} from './resource.schemas';
import { createResourceService, type ResourceService } from './resource.service';

type RouteParams = {
  workspaceId: string;
  projectId: string;
  folderId: string;
  fileId: string;
  bookmarkId: string;
};

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in');
  return req.auth.userId;
}

export interface ResourceRouterOptions {
  config: AppConfig;
  service?: ResourceService;
}

function buildService(config: AppConfig, injected?: ResourceService): ResourceService {
  if (injected) return injected;
  const storage = config.objectStorageEndpoint
    ? createS3CompatibleObjectStorage({
        endpoint: config.objectStorageEndpoint,
        bucket: config.objectStorageBucket,
        region: config.objectStorageRegion,
        accessKeyId: config.objectStorageAccessKeyId,
        secretAccessKey: config.objectStorageSecretAccessKey,
        requestTimeoutMs: config.objectStorageRequestTimeoutMs,
      })
    : null;
  return createResourceService(undefined, storage);
}

// Project-scoped resources: /workspaces/:workspaceId/projects/:projectId/resources
export function createProjectResourcesRouter({ config, service: injected }: ResourceRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();
  const service = buildService(config, injected);

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1, fields: 3 } }).single('file');
  const batchUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE_BYTES, files: RESOURCE_BATCH_MAX_FILES, fields: 5 } }).array('files', RESOURCE_BATCH_MAX_FILES);

  // Folders
  router.get('/folders', requireAuth, requireActive, validate({ params: projectScopeParamsSchema, query: listFoldersQuerySchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as RouteParams;
    const q = req.validated!.query as z.infer<typeof listFoldersQuerySchema>;
    sendSuccess(res, await service.listFolders({ userId: userId(req), workspaceId, projectId, parentId: q.parentId ?? null }));
  });

  router.post('/folders', requireAuth, requireActive, validate({ params: projectScopeParamsSchema, body: createFolderSchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as RouteParams;
    const body = req.validated!.body as z.infer<typeof createFolderSchema>;
    sendSuccess(res, await service.createFolder({ userId: userId(req), workspaceId, projectId, parentId: body.parentId ?? null, name: body.name }), 201);
  });

  router.get('/folders/:folderId/delete-impact', requireAuth, requireActive, validate({ params: projectFolderParamsSchema }), async (req, res) => {
    const { workspaceId, projectId, folderId } = req.validated!.params as RouteParams;
    sendSuccess(res, await service.getFolderDeleteImpact({ userId: userId(req), workspaceId, projectId, folderId }));
  });

  router.patch('/folders/:folderId', requireAuth, requireActive, validate({ params: projectFolderParamsSchema, body: renameFolderSchema }), async (req, res) => {
    const { workspaceId, projectId, folderId } = req.validated!.params as RouteParams;
    const body = req.validated!.body as z.infer<typeof renameFolderSchema>;
    sendSuccess(res, await service.renameFolder({ userId: userId(req), workspaceId, projectId, folderId, name: body.name }));
  });

  router.post('/folders/:folderId/move', requireAuth, requireActive, validate({ params: projectFolderParamsSchema, body: moveFolderSchema }), async (req, res) => {
    const { workspaceId, projectId, folderId } = req.validated!.params as RouteParams;
    const body = req.validated!.body as z.infer<typeof moveFolderSchema>;
    sendSuccess(res, await service.moveFolder({ userId: userId(req), workspaceId, projectId, folderId, parentId: body.parentId ?? null }));
  });

  router.delete('/folders/:folderId', requireAuth, requireActive, validate({ params: projectFolderParamsSchema }), async (req, res) => {
    const { workspaceId, projectId, folderId } = req.validated!.params as RouteParams;
    sendSuccess(res, await service.deleteFolder({ userId: userId(req), workspaceId, projectId, folderId }));
  });

  // Files
  router.get('/files', requireAuth, requireActive, validate({ params: projectScopeParamsSchema, query: listResourceFilesQuerySchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as RouteParams;
    const q = req.validated!.query as z.infer<typeof listResourceFilesQuerySchema>;
    sendSuccess(res, await service.listFiles({ userId: userId(req), workspaceId, projectId, folderId: q.folderId, cursor: q.cursor, limit: q.limit }));
  });

  router.post('/files', requireAuth, requireActive, (req, res, next) => {
    upload(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(413, 'FILE_TOO_LARGE', `File exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB limit`));
      }
      if (error) return next(new AppError(400, 'FILE_UPLOAD_INVALID', 'Invalid file upload'));
      next();
    });
  }, validate({ params: projectScopeParamsSchema }), async (req, res) => {
    if (!req.file) throw new AppError(400, 'FILE_REQUIRED', 'Select a file to upload');
    const mimeType = req.file.mimetype;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!ALLOWED_MIME_TYPES.includes(mimeType as any)) throw new AppError(415, 'FILE_TYPE_NOT_ALLOWED', `File type '${mimeType}' is not permitted`);
    const { workspaceId, projectId } = req.validated!.params as RouteParams;
    const folderId = typeof req.body?.folderId === 'string' ? req.body.folderId : null;
    sendSuccess(res, await service.uploadFile({ userId: userId(req), workspaceId, projectId, folderId, fileName: req.file.originalname, mimeType, sizeBytes: req.file.size, body: req.file.buffer }), 201);
  });

  // Folder batch upload
  router.post('/files/folder-upload', requireAuth, requireActive, (req, res, next) => {
    batchUpload(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return next(new AppError(413, 'FILE_TOO_LARGE', `A file exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB limit`));
      }
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_COUNT') {
        return next(new AppError(400, 'RESOURCE_BATCH_TOO_LARGE', `A maximum of ${RESOURCE_BATCH_MAX_FILES} files is allowed per batch`));
      }
      if (error) return next(new AppError(400, 'FILE_UPLOAD_INVALID', 'Invalid folder upload'));
      next();
    });
  }, validate({ params: projectScopeParamsSchema }), async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (files.length === 0) throw new AppError(400, 'FILE_REQUIRED', 'Select files to upload');
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total > RESOURCE_BATCH_MAX_TOTAL_BYTES) throw new AppError(413, 'RESOURCE_BATCH_TOO_LARGE', 'Total batch size exceeds the allowed limit');
    let metaRaw = req.body?.meta;
    if (typeof metaRaw === 'string') {
      try { metaRaw = JSON.parse(metaRaw); } catch { throw new AppError(400, 'VALIDATION_ERROR', 'Invalid batch metadata'); }
    }
    const meta = folderUploadMetaSchema.safeParse(metaRaw);
    if (!meta.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid batch metadata', { details: meta.error.issues });
    if (meta.data.files.length !== files.length) throw new AppError(400, 'VALIDATION_ERROR', 'Each uploaded file must have a relative path');
    const { workspaceId, projectId } = req.validated!.params as RouteParams;
    const parentFolderId = typeof req.body?.parentFolderId === 'string' ? req.body.parentFolderId : null;
    const payload = files.map((f, i) => ({
      relativePath: meta.data.files[i]!.relativePath,
      fileName: f.originalname,
      mimeType: f.mimetype,
      sizeBytes: f.size,
      body: f.buffer,
    }));
    sendSuccess(res, await service.uploadFolderBatch({ userId: userId(req), workspaceId, projectId, parentFolderId, files: payload }), 201);
  });

  router.get('/files/:fileId', requireAuth, requireActive, validate({ params: projectResourceFileParamsSchema }), async (req, res) => {
    const { workspaceId, projectId, fileId } = req.validated!.params as RouteParams;
    const result = await service.downloadFile({ userId: userId(req), workspaceId, projectId, fileId });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.fileName)}"`);
    res.status(200).send(result.body);
  });

  router.patch('/files/:fileId', requireAuth, requireActive, validate({ params: projectResourceFileParamsSchema, body: renameResourceFileSchema }), async (req, res) => {
    const { workspaceId, projectId, fileId } = req.validated!.params as RouteParams;
    const body = req.validated!.body as z.infer<typeof renameResourceFileSchema>;
    sendSuccess(res, await service.renameFile({ userId: userId(req), workspaceId, projectId, fileId, name: body.name }));
  });

  router.post('/files/:fileId/move', requireAuth, requireActive, validate({ params: projectResourceFileParamsSchema, body: moveResourceFileSchema }), async (req, res) => {
    const { workspaceId, projectId, fileId } = req.validated!.params as RouteParams;
    const body = req.validated!.body as z.infer<typeof moveResourceFileSchema>;
    sendSuccess(res, await service.moveFile({ userId: userId(req), workspaceId, projectId, fileId, folderId: body.folderId ?? null }));
  });

  router.delete('/files/:fileId', requireAuth, requireActive, validate({ params: projectResourceFileParamsSchema }), async (req, res) => {
    const { workspaceId, projectId, fileId } = req.validated!.params as RouteParams;
    sendSuccess(res, await service.deleteFile({ userId: userId(req), workspaceId, projectId, fileId }));
  });

  // Bookmarks
  router.get('/bookmarks', requireAuth, requireActive, validate({ params: projectScopeParamsSchema, query: listBookmarksQuerySchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as RouteParams;
    const q = req.validated!.query as z.infer<typeof listBookmarksQuerySchema>;
    sendSuccess(res, await service.listBookmarks({ userId: userId(req), workspaceId, projectId, limit: q.limit }));
  });
  router.post('/bookmarks', requireAuth, requireActive, validate({ params: projectScopeParamsSchema, body: bookmarkSchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as RouteParams;
    const body = req.validated!.body as z.infer<typeof bookmarkSchema>;
    sendSuccess(res, await service.createBookmark({ userId: userId(req), workspaceId, projectId, title: body.title, url: body.url }), 201);
  });
  router.patch('/bookmarks/:bookmarkId', requireAuth, requireActive, validate({ params: projectBookmarkParamsSchema, body: updateBookmarkSchema }), async (req, res) => {
    const { workspaceId, projectId, bookmarkId } = req.validated!.params as RouteParams;
    const body = req.validated!.body as z.infer<typeof updateBookmarkSchema>;
    sendSuccess(res, await service.updateBookmark({ userId: userId(req), workspaceId, projectId, bookmarkId, title: body.title, url: body.url }));
  });
  router.delete('/bookmarks/:bookmarkId', requireAuth, requireActive, validate({ params: projectBookmarkParamsSchema }), async (req, res) => {
    const { workspaceId, projectId, bookmarkId } = req.validated!.params as RouteParams;
    sendSuccess(res, await service.deleteBookmark({ userId: userId(req), workspaceId, projectId, bookmarkId }));
  });

  // Recent (project-scoped)
  router.get('/recent', requireAuth, requireActive, validate({ params: projectScopeParamsSchema, query: listRecentQuerySchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as RouteParams;
    const q = req.validated!.query as z.infer<typeof listRecentQuerySchema>;
    sendSuccess(res, await service.listRecent({ userId: userId(req), workspaceId, projectId, limit: q.limit }));
  });
  router.post('/recent', requireAuth, requireActive, validate({ params: projectScopeParamsSchema, body: recordRecentSchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as RouteParams;
    const body = req.validated!.body as z.infer<typeof recordRecentSchema>;
    sendSuccess(res, await service.recordRecent({ userId: userId(req), workspaceId, projectId, itemType: body.itemType, itemId: body.itemId }), 201);
  });

  // Dashboard
  router.get('/dashboard/overview', requireAuth, requireActive, validate({ params: projectScopeParamsSchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as RouteParams;
    sendSuccess(res, await service.getProjectDashboardOverview({ userId: userId(req), workspaceId, projectId }));
  });
  router.get('/dashboard/preferences', requireAuth, requireActive, validate({ params: projectScopeParamsSchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as RouteParams;
    sendSuccess(res, await service.getDashboardPreference({ userId: userId(req), workspaceId, projectId }));
  });
  router.put('/dashboard/preferences', requireAuth, requireActive, validate({ params: projectScopeParamsSchema, body: dashboardPreferenceSchema }), async (req, res) => {
    const { workspaceId, projectId } = req.validated!.params as RouteParams;
    const body = req.validated!.body as z.infer<typeof dashboardPreferenceSchema>;
    sendSuccess(res, await service.setDashboardPreference({ userId: userId(req), workspaceId, projectId, cards: body.cards }));
  });

  return router;
}

// Workspace-scoped resources (projectId null): /workspaces/:workspaceId/resources
export function createWorkspaceResourcesRouter({ config, service: injected }: ResourceRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();
  const service = buildService(config, injected);

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1, fields: 3 } }).single('file');
  const batchUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE_BYTES, files: RESOURCE_BATCH_MAX_FILES, fields: 5 } }).array('files', RESOURCE_BATCH_MAX_FILES);

  const projectId = null;

  router.get('/folders', requireAuth, requireActive, validate({ params: workspaceScopeParamsSchema, query: listFoldersQuerySchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as RouteParams;
    const q = req.validated!.query as z.infer<typeof listFoldersQuerySchema>;
    sendSuccess(res, await service.listFolders({ userId: userId(req), workspaceId, projectId, parentId: q.parentId ?? null }));
  });
  router.post('/folders', requireAuth, requireActive, validate({ params: workspaceScopeParamsSchema, body: createFolderSchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as RouteParams;
    const body = req.validated!.body as z.infer<typeof createFolderSchema>;
    sendSuccess(res, await service.createFolder({ userId: userId(req), workspaceId, projectId, parentId: body.parentId ?? null, name: body.name }), 201);
  });
  router.get('/folders/:folderId/delete-impact', requireAuth, requireActive, async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { workspaceId, folderId } = req.params as any;
    sendSuccess(res, await service.getFolderDeleteImpact({ userId: userId(req), workspaceId, projectId, folderId }));
  });
  router.patch('/folders/:folderId', requireAuth, requireActive, validate({ body: renameFolderSchema }), async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { workspaceId, folderId } = req.params as any;
    const body = req.validated!.body as z.infer<typeof renameFolderSchema>;
    sendSuccess(res, await service.renameFolder({ userId: userId(req), workspaceId, projectId, folderId, name: body.name }));
  });
  router.post('/folders/:folderId/move', requireAuth, requireActive, validate({ body: moveFolderSchema }), async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { workspaceId, folderId } = req.params as any;
    const body = req.validated!.body as z.infer<typeof moveFolderSchema>;
    sendSuccess(res, await service.moveFolder({ userId: userId(req), workspaceId, projectId, folderId, parentId: body.parentId ?? null }));
  });
  router.delete('/folders/:folderId', requireAuth, requireActive, async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { workspaceId, folderId } = req.params as any;
    sendSuccess(res, await service.deleteFolder({ userId: userId(req), workspaceId, projectId, folderId }));
  });

  router.get('/files', requireAuth, requireActive, validate({ params: workspaceScopeParamsSchema, query: listResourceFilesQuerySchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as RouteParams;
    const q = req.validated!.query as z.infer<typeof listResourceFilesQuerySchema>;
    sendSuccess(res, await service.listFiles({ userId: userId(req), workspaceId, projectId, folderId: q.folderId, cursor: q.cursor, limit: q.limit }));
  });
  router.post('/files', requireAuth, requireActive, (req, res, next) => {
    upload(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'FILE_TOO_LARGE', `File exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB limit`));
      if (error) return next(new AppError(400, 'FILE_UPLOAD_INVALID', 'Invalid file upload'));
      next();
    });
  }, async (req, res) => {
    if (!req.file) throw new AppError(400, 'FILE_REQUIRED', 'Select a file to upload');
    const mimeType = req.file.mimetype;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!ALLOWED_MIME_TYPES.includes(mimeType as any)) throw new AppError(415, 'FILE_TYPE_NOT_ALLOWED', `File type '${mimeType}' is not permitted`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { workspaceId } = req.params as any;
    const folderId = typeof req.body?.folderId === 'string' ? req.body.folderId : null;
    sendSuccess(res, await service.uploadFile({ userId: userId(req), workspaceId, projectId, folderId, fileName: req.file.originalname, mimeType, sizeBytes: req.file.size, body: req.file.buffer }), 201);
  });
  router.post('/files/folder-upload', requireAuth, requireActive, (req, res, next) => {
    batchUpload(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'FILE_TOO_LARGE', 'A file exceeds the size limit'));
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_COUNT') return next(new AppError(400, 'RESOURCE_BATCH_TOO_LARGE', `A maximum of ${RESOURCE_BATCH_MAX_FILES} files is allowed per batch`));
      if (error) return next(new AppError(400, 'FILE_UPLOAD_INVALID', 'Invalid folder upload'));
      next();
    });
  }, async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (files.length === 0) throw new AppError(400, 'FILE_REQUIRED', 'Select files to upload');
    const total = files.reduce((s, f) => s + f.size, 0);
    if (total > RESOURCE_BATCH_MAX_TOTAL_BYTES) throw new AppError(413, 'RESOURCE_BATCH_TOO_LARGE', 'Total batch size exceeds the allowed limit');
    let metaRaw = req.body?.meta;
    if (typeof metaRaw === 'string') { try { metaRaw = JSON.parse(metaRaw); } catch { throw new AppError(400, 'VALIDATION_ERROR', 'Invalid batch metadata'); } }
    const meta = folderUploadMetaSchema.safeParse(metaRaw);
    if (!meta.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid batch metadata', { details: meta.error.issues });
    if (meta.data.files.length !== files.length) throw new AppError(400, 'VALIDATION_ERROR', 'Each uploaded file must have a relative path');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { workspaceId } = req.params as any;
    const parentFolderId = typeof req.body?.parentFolderId === 'string' ? req.body.parentFolderId : null;
    const payload = files.map((f, i) => ({ relativePath: meta.data.files[i]!.relativePath, fileName: f.originalname, mimeType: f.mimetype, sizeBytes: f.size, body: f.buffer }));
    sendSuccess(res, await service.uploadFolderBatch({ userId: userId(req), workspaceId, projectId, parentFolderId, files: payload }), 201);
  });
  router.get('/files/:fileId', requireAuth, requireActive, async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { workspaceId, fileId } = req.params as any;
    const result = await service.downloadFile({ userId: userId(req), workspaceId, projectId, fileId });
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.fileName)}"`);
    res.status(200).send(result.body);
  });
  router.patch('/files/:fileId', requireAuth, requireActive, validate({ body: renameResourceFileSchema }), async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { workspaceId, fileId } = req.params as any;
    const body = req.validated!.body as z.infer<typeof renameResourceFileSchema>;
    sendSuccess(res, await service.renameFile({ userId: userId(req), workspaceId, projectId, fileId, name: body.name }));
  });
  router.post('/files/:fileId/move', requireAuth, requireActive, validate({ body: moveResourceFileSchema }), async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { workspaceId, fileId } = req.params as any;
    const body = req.validated!.body as z.infer<typeof moveResourceFileSchema>;
    sendSuccess(res, await service.moveFile({ userId: userId(req), workspaceId, projectId, fileId, folderId: body.folderId ?? null }));
  });
  router.delete('/files/:fileId', requireAuth, requireActive, async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { workspaceId, fileId } = req.params as any;
    sendSuccess(res, await service.deleteFile({ userId: userId(req), workspaceId, projectId, fileId }));
  });

  router.get('/bookmarks', requireAuth, requireActive, validate({ params: workspaceScopeParamsSchema, query: listBookmarksQuerySchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as RouteParams;
    const q = req.validated!.query as z.infer<typeof listBookmarksQuerySchema>;
    sendSuccess(res, await service.listBookmarks({ userId: userId(req), workspaceId, projectId, limit: q.limit }));
  });
  router.post('/bookmarks', requireAuth, requireActive, validate({ params: workspaceScopeParamsSchema, body: bookmarkSchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as RouteParams;
    const body = req.validated!.body as z.infer<typeof bookmarkSchema>;
    sendSuccess(res, await service.createBookmark({ userId: userId(req), workspaceId, projectId, title: body.title, url: body.url }), 201);
  });
  router.patch('/bookmarks/:bookmarkId', requireAuth, requireActive, validate({ body: updateBookmarkSchema }), async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { workspaceId, bookmarkId } = req.params as any;
    const body = req.validated!.body as z.infer<typeof updateBookmarkSchema>;
    sendSuccess(res, await service.updateBookmark({ userId: userId(req), workspaceId, projectId, bookmarkId, title: body.title, url: body.url }));
  });
  router.delete('/bookmarks/:bookmarkId', requireAuth, requireActive, async (req, res) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { workspaceId, bookmarkId } = req.params as any;
    sendSuccess(res, await service.deleteBookmark({ userId: userId(req), workspaceId, projectId, bookmarkId }));
  });

  return router;
}
