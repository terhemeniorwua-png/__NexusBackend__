import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  automationParamsSchema,
  automationRunParamsSchema,
  automationWorkspaceParams,
  createAutomationSchema,
  listAutomationRunsQuerySchema,
  updateAutomationSchema,
  type CreateAutomationInput,
} from './automation.service';
import { createAutomationService } from './automation.service';

export interface AutomationRouterOptions { config: AppConfig; service?: ReturnType<typeof createAutomationService> }
function userId(req: Request): string { if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in'); return req.auth.userId; }

export function createAutomationRouter({ config, service = createAutomationService() }: AutomationRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get('/', requireAuth, requireActive, validate({ params: automationWorkspaceParams }), async (req, res) => {
    const { workspaceId } = req.validated!.params as { workspaceId: string };
    sendSuccess(res, await service.list({ userId: userId(req), workspaceId }));
  });
  router.post('/', requireAuth, requireActive, validate({ params: automationWorkspaceParams, body: createAutomationSchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as { workspaceId: string };
    const body = req.validated!.body as CreateAutomationInput;
    sendSuccess(res, await service.create({ userId: userId(req), workspaceId, ...body }), 201);
  });
  router.get('/:automationId', requireAuth, requireActive, validate({ params: automationParamsSchema }), async (req, res) => {
    const { workspaceId, automationId } = req.validated!.params as { workspaceId: string; automationId: string };
    sendSuccess(res, await service.get({ userId: userId(req), workspaceId, automationId }));
  });
  router.get('/:automationId/runs', requireAuth, requireActive, validate({ params: automationParamsSchema, query: listAutomationRunsQuerySchema }), async (req, res) => {
    const { workspaceId, automationId } = req.validated!.params as { workspaceId: string; automationId: string };
    const { limit } = req.validated!.query as { limit?: number };
    sendSuccess(res, await service.listRuns({ userId: userId(req), workspaceId, automationId, limit }));
  });
  router.post('/:automationId/runs/:runId/retry', requireAuth, requireActive, validate({ params: automationRunParamsSchema }), async (req, res) => {
    const { workspaceId, automationId, runId } = req.validated!.params as { workspaceId: string; automationId: string; runId: string };
    sendSuccess(res, await service.retryRun({ userId: userId(req), workspaceId, automationId, runId }));
  });
  router.patch('/:automationId', requireAuth, requireActive, validate({ params: automationParamsSchema, body: updateAutomationSchema }), async (req, res) => {
    const { workspaceId, automationId } = req.validated!.params as { workspaceId: string; automationId: string };
    const { name, enabled } = req.validated!.body as { name?: string; enabled?: boolean };
    sendSuccess(res, await service.update({ userId: userId(req), workspaceId, automationId, name, enabled }));
  });
  router.delete('/:automationId', requireAuth, requireActive, validate({ params: automationParamsSchema }), async (req, res) => {
    const { workspaceId, automationId } = req.validated!.params as { workspaceId: string; automationId: string };
    await service.delete({ userId: userId(req), workspaceId, automationId });
    sendSuccess(res, { ok: true });
  });
  return router;
}
