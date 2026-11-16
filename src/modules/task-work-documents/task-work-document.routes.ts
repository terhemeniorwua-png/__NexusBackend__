import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  createTaskWorkDocumentSchema,
  listTaskWorkDocumentsQuerySchema,
  restoreTaskWorkDocumentSchema,
  taskWorkDocumentParamsSchema,
  taskWorkDocumentTaskParamsSchema,
  taskWorkDocumentVersionParamsSchema,
  updateTaskWorkDocumentSchema,
  type CreateTaskWorkDocumentInput,
  type UpdateTaskWorkDocumentInput,
} from './task-work-document.schemas';
import { createTaskWorkDocumentService } from './task-work-document.service';

type TaskParams = { workspaceId: string; projectId: string; taskId: string };
type DocParams = TaskParams & { documentId: string };
type VersionParams = DocParams & { version: number };

function context(req: Request) {
  return { ip: req.ip, userAgent: req.header('user-agent') };
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'You must be signed in to continue');
  return req.auth.userId;
}

export function createTaskWorkDocumentRouter(options: { config: AppConfig; service?: ReturnType<typeof createTaskWorkDocumentService> }): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(options.config);
  const requireActiveAccount = createRequireActiveAccount();
  const service = options.service ?? createTaskWorkDocumentService();

  router.get('/', requireAuth, requireActiveAccount, validate({ params: taskWorkDocumentTaskParamsSchema, query: listTaskWorkDocumentsQuerySchema }), async (req, res) => {
    const { workspaceId, projectId, taskId } = req.validated!.params as TaskParams;
    sendSuccess(res, await service.list({ userId: userId(req), workspaceId, projectId, taskId }));
  });

  router.post('/', requireAuth, requireActiveAccount, validate({ params: taskWorkDocumentTaskParamsSchema, body: createTaskWorkDocumentSchema }), async (req, res) => {
    const { workspaceId, projectId, taskId } = req.validated!.params as TaskParams;
    const body = req.validated!.body as CreateTaskWorkDocumentInput;
    sendSuccess(res, await service.create({ userId: userId(req), workspaceId, projectId, taskId, ...body }, context(req)), 201);
  });

  router.get('/:documentId', requireAuth, requireActiveAccount, validate({ params: taskWorkDocumentParamsSchema }), async (req, res) => {
    const { workspaceId, projectId, taskId, documentId } = req.validated!.params as DocParams;
    sendSuccess(res, await service.get({ userId: userId(req), workspaceId, projectId, taskId, documentId }));
  });

  router.patch('/:documentId', requireAuth, requireActiveAccount, validate({ params: taskWorkDocumentParamsSchema, body: updateTaskWorkDocumentSchema }), async (req, res) => {
    const { workspaceId, projectId, taskId, documentId } = req.validated!.params as DocParams;
    const body = req.validated!.body as UpdateTaskWorkDocumentInput;
    sendSuccess(res, await service.update({ userId: userId(req), workspaceId, projectId, taskId, documentId, baseVersion: body.baseVersion, content: body.content, title: body.title, mode: body.mode }, context(req)));
  });

  router.get('/:documentId/versions', requireAuth, requireActiveAccount, validate({ params: taskWorkDocumentParamsSchema }), async (req, res) => {
    const { workspaceId, projectId, taskId, documentId } = req.validated!.params as DocParams;
    sendSuccess(res, await service.listVersions({ userId: userId(req), workspaceId, projectId, taskId, documentId }));
  });

  router.get('/:documentId/versions/:version', requireAuth, requireActiveAccount, validate({ params: taskWorkDocumentVersionParamsSchema }), async (req, res) => {
    const { workspaceId, projectId, taskId, documentId, version } = req.validated!.params as VersionParams;
    sendSuccess(res, await service.getVersion({ userId: userId(req), workspaceId, projectId, taskId, documentId, version }));
  });

  router.post('/:documentId/versions/:version/restore', requireAuth, requireActiveAccount, validate({ params: taskWorkDocumentVersionParamsSchema, body: restoreTaskWorkDocumentSchema }), async (req, res) => {
    const { workspaceId, projectId, taskId, documentId, version } = req.validated!.params as VersionParams;
    sendSuccess(res, await service.restore({ userId: userId(req), workspaceId, projectId, taskId, documentId, version }, context(req)));
  });

  router.delete('/:documentId', requireAuth, requireActiveAccount, validate({ params: taskWorkDocumentParamsSchema }), async (req, res) => {
    const { workspaceId, projectId, taskId, documentId } = req.validated!.params as DocParams;
    sendSuccess(res, await service.remove({ userId: userId(req), workspaceId, projectId, taskId, documentId }, context(req)));
  });

  return router;
}
