import { Router, type Request } from 'express';
import type { AppConfig } from '../../config/env';
import { createRequireActiveAccount, createRequireAuth } from '../../middleware/authenticate';
import { validate } from '../../middleware/validation';
import { AppError } from '../../utils/errors';
import { sendSuccess } from '../../utils/http';
import {
  createWebhookSchema,
  listDeliveriesQuerySchema,
  updateWebhookSchema,
  webhookDeliveryParamsSchema,
  webhookParamsSchema,
  webhookWorkspaceParams,
  type CreateWebhookInput,
  type ListDeliveriesQuery,
  type UpdateWebhookInput,
} from './webhook.schemas';
import { createWebhookService } from './webhook.service';

export interface WebhookRouterOptions {
  config: AppConfig;
  service?: ReturnType<typeof createWebhookService>;
}

function userId(req: Request): string {
  if (!req.auth) throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Sign in');
  return req.auth.userId;
}

export function createWebhookRouter({
  config,
  service = createWebhookService(),
}: WebhookRouterOptions): Router {
  const router = Router({ mergeParams: true });
  const requireAuth = createRequireAuth(config);
  const requireActive = createRequireActiveAccount();

  router.get(
    '/',
    requireAuth,
    requireActive,
    validate({ params: webhookWorkspaceParams }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      sendSuccess(res, await service.list({ userId: userId(req), workspaceId }));
    },
  );

  router.post(
    '/',
    requireAuth,
    requireActive,
    validate({ params: webhookWorkspaceParams, body: createWebhookSchema }),
    async (req, res) => {
      const { workspaceId } = req.validated!.params as { workspaceId: string };
      const body = req.validated!.body as CreateWebhookInput;
      sendSuccess(res, await service.create({ userId: userId(req), workspaceId, ...body }), 201);
    },
  );

  router.patch(
    '/:webhookId',
    requireAuth,
    requireActive,
    validate({ params: webhookParamsSchema, body: updateWebhookSchema }),
    async (req, res) => {
      const { workspaceId, webhookId } = req.validated!.params as {
        workspaceId: string;
        webhookId: string;
      };
      const body = req.validated!.body as UpdateWebhookInput;
      sendSuccess(
        res,
        await service.update({ userId: userId(req), workspaceId, webhookId, ...body }),
      );
    },
  );

  router.delete(
    '/:webhookId',
    requireAuth,
    requireActive,
    validate({ params: webhookParamsSchema }),
    async (req, res) => {
      const { workspaceId, webhookId } = req.validated!.params as {
        workspaceId: string;
        webhookId: string;
      };
      await service.delete({ userId: userId(req), workspaceId, webhookId });
      sendSuccess(res, { ok: true });
    },
  );

  router.get(
    '/:webhookId/deliveries',
    requireAuth,
    requireActive,
    validate({ params: webhookParamsSchema, query: listDeliveriesQuerySchema }),
    async (req, res) => {
      const { workspaceId, webhookId } = req.validated!.params as {
        workspaceId: string;
        webhookId: string;
      };
      const { limit } = req.validated!.query as ListDeliveriesQuery;
      sendSuccess(
        res,
        await service.listDeliveries({ userId: userId(req), workspaceId, webhookId, limit }),
      );
    },
  );

  router.post(
    '/:webhookId/deliveries/:deliveryId/retry',
    requireAuth,
    requireActive,
    validate({ params: webhookDeliveryParamsSchema }),
    async (req, res) => {
      const { workspaceId, webhookId, deliveryId } = req.validated!.params as {
        workspaceId: string;
        webhookId: string;
        deliveryId: string;
      };
      sendSuccess(
        res,
        await service.retryDelivery({ userId: userId(req), workspaceId, webhookId, deliveryId }),
      );
    },
  );

  return router;
}
