import { Router, type Request, type Response } from 'express';
import express from 'express';
import type { AppConfig } from '../../config/env';
import { processGitlabWebhook } from './gitlab-webhook.service';
import { logger as defaultLogger } from '../../utils/logger';

export interface GitlabWebhookRouterOptions {
  config: AppConfig;
}

export function createGitlabWebhookRouter({ config }: GitlabWebhookRouterOptions): Router {
  const router = Router();

  router.post(
    '/gitlab',
    express.raw({ type: '*/*', limit: config.requestBodyLimit }),
    async (req: Request, res: Response) => {
      if (!config.gitlabWebhookSecret) {
        res.status(503).json({ success: false, error: { code: 'GITLAB_WEBHOOK_NOT_CONFIGURED', message: 'GitLab webhook is not configured' } });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (rawBody.length === 0) {
        res.status(400).json({ success: false, error: { code: 'WEBHOOK_EMPTY_BODY', message: 'Webhook payload is empty' } });
        return;
      }

      const token = req.get('x-gitlab-token') ?? undefined;
      const event = req.get('x-gitlab-event') ?? undefined;
      const eventUuid = req.get('x-gitlab-event-uuid') ?? req.get('x-gitlab-webhook-uuid') ?? undefined;

      const outcome = await processGitlabWebhook({
        rawBody,
        token,
        secret: config.gitlabWebhookSecret,
        event,
        eventUuid,
        logger: defaultLogger,
      });

      if (outcome === 'unverified') {
        res.status(401).json({ success: false, error: { code: 'WEBHOOK_TOKEN_INVALID', message: 'Webhook token is not valid' } });
        return;
      }
      if (outcome === 'invalid') {
        res.status(400).json({ success: false, error: { code: 'WEBHOOK_INVALID', message: 'Webhook payload is invalid' } });
        return;
      }

      res.status(200).json({ success: true, data: { received: true, outcome } });
    },
  );

  return router;
}
