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
  fileParamsSchema,
  fileWorkspaceParamsSchema,
  listFilesQuerySchema,
  MAX_FILE_SIZE_BYTES,
  type ListFilesQuery,
} from './file.schemas';
import { createFileService } from './file.service';

export interface FileRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createFileService>;
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in');
  return req.auth.userId;
}

export function createFileRouter({
  config,
  service: injectedService,
}: FileRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();

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

  const service = injectedService ?? createFileService(undefined, storage);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1, fields: 3 },
  }).single('file');

  const versionUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1, fields: 2 },
  }).single('file');

  // GET /workspaces/:workspaceId/files — list workspace files
  router.get(
    '/',
    requireAuth,
    requireActiveAccount,
    validate({ params: fileWorkspaceParamsSchema, query: listFilesQuerySchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const query = req.validated!.query as ListFilesQuery;
      sendSuccess(
        res,
        await service.list({
          userId: userId(req),
          workspaceId,
          projectId: query.projectId,
          taskId: query.taskId,
          cursor: query.cursor,
          limit: query.limit,
        }),
      );
    },
  );

  // GET /workspaces/:workspaceId/files/usage — storage usage stats
  router.get(
    '/usage',
    requireAuth,
    requireActiveAccount,
    validate({ params: fileWorkspaceParamsSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(res, await service.getUsage({ userId: userId(req), workspaceId }));
    },
  );

  // POST /workspaces/:workspaceId/files — upload a file
  router.post(
    '/',
    requireAuth,
    requireActiveAccount,
    (req, res, next) => {
      upload(req, res, (error: unknown) => {
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          return next(new AppError(413, 'FILE_TOO_LARGE', `File exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB limit`));
        }
        if (error) {
          return next(new AppError(400, 'FILE_UPLOAD_INVALID', 'Invalid file upload'));
        }
        next();
      });
    },
    validate({ params: fileWorkspaceParamsSchema }),
    async (req, res) => {
      if (!req.file) {
        throw new AppError(400, 'FILE_REQUIRED', 'Select a file to upload');
      }

      const mimeType = req.file.mimetype;
      if (!ALLOWED_MIME_TYPES.includes(mimeType as (typeof ALLOWED_MIME_TYPES)[number])) {
        throw new AppError(415, 'FILE_TYPE_NOT_ALLOWED', `File type '${mimeType}' is not permitted`);
      }

      const { workspaceId } = req.validated!.params as { workspaceId: string };
      // Optional project / task association from form fields
      const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : undefined;
      const taskId = typeof req.body?.taskId === 'string' ? req.body.taskId : undefined;

      sendSuccess(
        res,
        await service.upload({
          userId: userId(req),
          workspaceId,
          fileName: req.file.originalname,
          mimeType,
          sizeBytes: req.file.size,
          body: req.file.buffer,
          projectId: projectId ?? null,
          taskId: taskId ?? null,
        }),
        201,
      );
    },
  );

  // POST /workspaces/:workspaceId/files/:fileId/versions — upload the next version
  router.post(
    '/:fileId/versions',
    requireAuth,
    requireActiveAccount,
    (req, res, next) => {
      versionUpload(req, res, (error: unknown) => {
        if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
          return next(new AppError(413, 'FILE_TOO_LARGE', `File exceeds the ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB limit`));
        }
        if (error) {
          return next(new AppError(400, 'FILE_UPLOAD_INVALID', 'Invalid file upload'));
        }
        next();
      });
    },
    validate({ params: fileParamsSchema }),
    async (req, res) => {
      if (!req.file) {
        throw new AppError(400, 'FILE_REQUIRED', 'Select a file to upload');
      }
      const mimeType = req.file.mimetype;
      if (!ALLOWED_MIME_TYPES.includes(mimeType as (typeof ALLOWED_MIME_TYPES)[number])) {
        throw new AppError(415, 'FILE_TYPE_NOT_ALLOWED', `File type '${mimeType}' is not permitted`);
      }
      const { workspaceId, fileId } = req.validated!.params as {
        workspaceId: string;
        fileId: string;
      };
      const changeNote = typeof req.body?.changeNote === 'string' ? req.body.changeNote : null;
      sendSuccess(
        res,
        await service.uploadVersion({
          userId: userId(req),
          workspaceId,
          fileId,
          fileName: req.file.originalname,
          mimeType,
          body: req.file.buffer,
          changeNote,
        }),
        201,
      );
    },
  );

  // GET /workspaces/:workspaceId/files/:fileId — download a file
  router.get(
    '/:fileId',
    requireAuth,
    requireActiveAccount,
    validate({ params: fileParamsSchema }),
    async (req, res) => {
      const { workspaceId, fileId } = req.validated!.params as {
        workspaceId: string;
        fileId: string;
      };
      const result = await service.download({ userId: userId(req), workspaceId, fileId });
      res.setHeader('Content-Type', result.contentType);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(result.fileName)}"`,
      );
      res.status(200).send(result.body);
    },
  );

  // DELETE /workspaces/:workspaceId/files/:fileId — delete a file
  router.delete(
    '/:fileId',
    requireAuth,
    requireActiveAccount,
    validate({ params: fileParamsSchema }),
    async (req, res) => {
      const { workspaceId, fileId } = req.validated!.params as {
        workspaceId: string;
        fileId: string;
      };
      await service.delete({ userId: userId(req), workspaceId, fileId });
      sendSuccess(res, { ok: true });
    },
  );

  return router;
}
