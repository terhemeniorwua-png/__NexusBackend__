import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { userWorkspaceAccessContext } from '../workspaces/authorization';
import { sendSuccess } from '../../utils/http';
import { z } from 'zod';
import {
  createFormSchema, formFieldSchema, formParamsSchema, formWorkspaceParams,
  listFormsQuerySchema, submitResponseSchema, updateFormSchema,
  type CreateFormInput, type FormFieldInput, type ListFormsQuery,
  type SubmitResponseInput, type UpdateFormInput,
} from './form.schemas';
import { createFormService } from './form.service';

export interface FormRouterOptions { config: AppConfig; service?: ReturnType<typeof createFormService> }
function authCtx(req: Request) { if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in'); return req.auth; }

export function createFormRouter({ config, service = createFormService() }: FormRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get('/', requireAuth, requireActive, validate({ params: formWorkspaceParams, query: listFormsQuerySchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as { workspaceId: string };
    const q = req.validated!.query as ListFormsQuery;
    sendSuccess(res, await service.list({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, ...q }));
  });
  router.post('/', requireAuth, requireActive, validate({ params: formWorkspaceParams, body: createFormSchema }), async (req, res) => {
    const { workspaceId } = req.validated!.params as { workspaceId: string };
    const body = req.validated!.body as CreateFormInput;
    sendSuccess(res, await service.create({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, ...body }), 201);
  });
  router.get('/:formId', requireAuth, requireActive, validate({ params: formParamsSchema }), async (req, res) => {
    const { workspaceId, formId } = req.validated!.params as { workspaceId: string; formId: string };
    sendSuccess(res, await service.get({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, formId }));
  });
  router.patch('/:formId', requireAuth, requireActive, validate({ params: formParamsSchema, body: updateFormSchema }), async (req, res) => {
    const { workspaceId, formId } = req.validated!.params as { workspaceId: string; formId: string };
    const body = req.validated!.body as UpdateFormInput;
    sendSuccess(res, await service.update({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, formId, ...body }));
  });
  router.delete('/:formId', requireAuth, requireActive, validate({ params: formParamsSchema }), async (req, res) => {
    const { workspaceId, formId } = req.validated!.params as { workspaceId: string; formId: string };
    await service.delete({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, formId });
    sendSuccess(res, { ok: true });
  });
  router.post('/:formId/fields', requireAuth, requireActive, validate({ params: formParamsSchema, body: formFieldSchema }), async (req, res) => {
    const { workspaceId, formId } = req.validated!.params as { workspaceId: string; formId: string };
    const body = req.validated!.body as FormFieldInput;
    sendSuccess(res, await service.addField({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, formId, ...body }), 201);
  });
  router.post('/:formId/responses', requireAuth, requireActive, validate({ params: formParamsSchema, body: submitResponseSchema }), async (req, res) => {
    const { workspaceId, formId } = req.validated!.params as { workspaceId: string; formId: string };
    const body = req.validated!.body as SubmitResponseInput;
    await service.submitResponse({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, formId, ...body });
    sendSuccess(res, { ok: true }, 201);
  });
  router.get('/:formId/responses', requireAuth, requireActive, validate({ params: formParamsSchema, query: z.object({ cursor: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }) }), async (req, res) => {
    const { workspaceId, formId } = req.validated!.params as { workspaceId: string; formId: string };
    const { cursor, limit } = req.validated!.query as { cursor?: string; limit: number };
    sendSuccess(res, await service.listResponses({ userId: authCtx(req).userId, context: userWorkspaceAccessContext(authCtx(req)), workspaceId, formId, cursor, limit }));
  });
  return router;
}
