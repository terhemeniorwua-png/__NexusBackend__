import { Router, type Request, type Response } from 'express';
import express from 'express';
import type { AppConfig } from '../../config/env';
import { processGithubWebhook } from './github-webhook.service';
import { logger as defaultLogger } from '../../utils/logger';

export interface GithubWebhookRouterOptions {
  config: AppConfig;
}

export function createGithubWebhookRouter({ config }: GithubWebhookRouterOptions): Router {
  const router = Router();

  router.post(
    '/github',
    express.raw({ type: '*/*', limit: config.requestBodyLimit }),
    async (req: Request, res: Response) => {
      if (!config.githubAppWebhookSecret) {
        res.status(503).json({ success: false, error: { code: 'GITHUB_WEBHOOK_NOT_CONFIGURED', message: 'GitHub webhook is not configured' } });
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (rawBody.length === 0) {
        res.status(400).json({ success: false, error: { code: 'WEBHOOK_EMPTY_BODY', message: 'Webhook payload is empty' } });
        return;
      }

      const signature = req.get('x-hub-signature-256') ?? undefined;
      const deliveryId = req.get('x-github-delivery') ?? undefined;
      const event = req.get('x-github-event') ?? undefined;

      const outcome = await processGithubWebhook({
        rawBody,
        signature,
        secret: config.githubAppWebhookSecret,
        deliveryId,
        event,
        logger: defaultLogger,
      });

      if (outcome === 'unverified') {
        res.status(401).json({ success: false, error: { code: 'WEBHOOK_SIGNATURE_INVALID', message: 'Webhook signature is not valid' } });
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
