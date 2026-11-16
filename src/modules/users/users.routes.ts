import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { ipKeyGenerator } from 'express-rate-limit';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { createRateLimiter } from '../../middleware/rate-limit';
import { validateBody } from '../../middleware/validation';
import { createS3CompatibleObjectStorage } from '../../services/storage/private-object-storage';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import { updateProfileSchema, type UpdateProfileInput } from './users.schemas';
import { createUsersService, type UsersService } from './users.service';

/**
 * Profile routes.
 *
 * A profile belongs to an activated account, so the routes sit behind both the
 * session guard and the activation guard.
 *
 * Avatar upload uses the multipart field name "file" as specified by the API
 * contract. The file limit is enforced by multer before the handler runs, so
 * oversized uploads are rejected while the body is still streaming.
 */

export interface UsersRouterOptions {
  config: AppConfig;
  service?: UsersService;
}

export function createUsersRouter({
  config,
  service: injectedService,
}: UsersRouterOptions): Router {
  const router = Router();
  const requireAuth = createRequireAuth(config);
  const requireActiveAccount = createRequireActiveAccount();
  const avatarLimiter = createRateLimiter({
    namespace: `${config.rateLimitNamespace}:profile-avatar`,
    windowMs: config.authRateLimitWindowMs,
    limit: config.avatarRateLimitMax,
    keyGenerator: (req) =>
      `${ipKeyGenerator(req.ip ?? 'unknown')}:${req.auth?.userId ?? 'unknown'}`,
    code: 'AVATAR_RATE_LIMITED',
    message: 'Too many profile image changes. Please try again later.',
  });

  // Field name is "file" as required by the API contract.
  // parts: 2 allows 1 field + 1 file (multer counts both against parts).
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.avatarMaxFileSizeBytes, files: 1, fields: 0, parts: 2 },
  }).single('file');

  const storage = createS3CompatibleObjectStorage({
    endpoint: config.objectStorageEndpoint,
    bucket: config.objectStorageBucket,
    region: config.objectStorageRegion,
    accessKeyId: config.objectStorageAccessKeyId,
    secretAccessKey: config.objectStorageSecretAccessKey,
    requestTimeoutMs: config.objectStorageRequestTimeoutMs,
    maxReadBytes: config.avatarMaxFileSizeBytes,
  });
  const service = injectedService ?? createUsersService(undefined, storage);

  /**
   * Wraps multer so that:
   *   - An oversized file → 413 AVATAR_TOO_LARGE (before the body is fully buffered).
   *   - Any other multer error → 400 AVATAR_UPLOAD_INVALID.
   */
  function receiveAvatar(req: Request, _res: Response, next: (error?: unknown) => void): void {
    avatarUpload(req, _res, (error: unknown) => {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        next(
          new AppError(413, 'AVATAR_TOO_LARGE', 'The profile image exceeds the upload size limit'),
        );
        return;
      }
      if (error) {
        next(
          new AppError(400, 'AVATAR_UPLOAD_INVALID', 'Upload exactly one file in the file field'),
        );
        return;
      }
      next();
    });
  }

  router.get('/me', requireAuth, requireActiveAccount, async (req: Request, res: Response) => {
    const auth = req.auth;

    if (!auth) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
    }

    const profile = await service.getProfile(auth.userId);

    sendSuccess(res, profile);
  });

  router.get(
    '/me/avatar',
    requireAuth,
    requireActiveAccount,
    async (req: Request, res: Response) => {
      const auth = req.auth;
      if (!auth)
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      const avatar = await service.getAvatar(auth.userId);
      res.setHeader('Content-Type', avatar.contentType);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).send(avatar.body);
    },
  );

  router.post(
    '/me/avatar',
    requireAuth,
    requireActiveAccount,
    avatarLimiter,
    receiveAvatar,
    async (req: Request, res: Response) => {
      const auth = req.auth;
      if (!auth)
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      if (!req.file)
        throw new AppError(400, 'AVATAR_MISSING_FILE', 'Select a profile image to upload');
      const result = await service.uploadAvatar(
        auth.userId,
        req.file.buffer,
        {
          maxDimension: config.avatarMaxDimension,
          maxPixels: config.avatarMaxPixels,
        },
        { ip: req.ip, userAgent: req.header('user-agent') },
      );
      sendSuccess(res, result);
    },
  );

  router.delete(
    '/me/avatar',
    requireAuth,
    requireActiveAccount,
    avatarLimiter,
    async (req: Request, res: Response) => {
      const auth = req.auth;
      if (!auth)
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      const result = await service.deleteAvatar(auth.userId, {
        ip: req.ip,
        userAgent: req.header('user-agent'),
      });
      sendSuccess(res, result);
    },
  );

  router.patch(
    '/me',
    requireAuth,
    requireActiveAccount,
    validateBody(updateProfileSchema),
    async (req: Request, res: Response) => {
      const auth = req.auth;

      if (!auth) {
        throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
      }

      const input = req.validated?.body as UpdateProfileInput;
      const profile = await service.updateProfile(auth.userId, input);

      sendSuccess(res, profile);
    },
  );

  return router;
}
