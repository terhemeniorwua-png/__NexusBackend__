import { Router, type Request, type Response } from 'express';
import express from 'express';
import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import { processProviderWebhook } from '../../services/email';
import { AppError } from '../../utils/errors';
import { logger as defaultLogger, type Logger } from '../../utils/logger';

/**
 * Provider webhook endpoint.
 *
 * The route is mounted before the JSON body parser, because the signature is
 * calculated over the raw request body. A payload that was parsed and
 * re-serialised cannot be verified.
 *
 * The endpoint is public, so it is protected by a shared secret instead of
 * by a session. Two mechanisms are supported:
 *
 * - A provider that signs its events sends a signature in the configured
 *   header.
 * - A provider that does not sign its events, Brevo among them, is verified
 *   with the token that the webhook URL carries.
 *
 * The response tells the provider that the event was received, even when the
 * event is unknown, so it does not retry a payload that will never be
 * understood.
 */
export interface EmailWebhookRouterOptions {
  config: AppConfig;
  prisma?: PrismaClient;
  logger?: Logger;
}

export function createEmailWebhookRouter(options: EmailWebhookRouterOptions): Router {
  const router = Router();
  const prisma = options.prisma ?? getPrismaClient();
  const log = options.logger ?? defaultLogger;

  const handler = async (req: Request, res: Response): Promise<void> => {
    if (!options.config.emailWebhookSecret && !options.config.emailWebhookToken) {
      throw new AppError(
        503,
        'WEBHOOK_DISABLED',
        'The email webhook endpoint is not configured for this deployment',
      );
    }

    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    if (rawBody.length === 0) {
      throw new AppError(400, 'WEBHOOK_EMPTY_BODY', 'The webhook payload is empty');
    }

    const signature = req.get(options.config.emailWebhookSignatureHeader) ?? undefined;
    const token = typeof req.params.token === 'string' ? req.params.token : undefined;

    const outcome = await processProviderWebhook({
      prisma,
      provider: options.config.emailProvider,
      rawBody,
      signature,
      secret: options.config.emailWebhookSecret,
      token,
      expectedToken: options.config.emailWebhookToken,
      toleranceSeconds: options.config.emailWebhookToleranceSeconds,
      logger: log,
    });

    if (outcome === 'unverified') {
      throw new AppError(401, 'WEBHOOK_SIGNATURE_INVALID', 'The webhook signature is not valid');
    }

    res.status(200).json({
      success: true,
      data: { received: true, outcome },
    });
  };

  router.post(
    '/email',
    express.raw({ type: '*/*', limit: options.config.requestBodyLimit }),
    handler,
  );

  // The token variant is the URL that a provider without a signed payload is
  // configured with.
  router.post(
    '/email/:token',
    express.raw({ type: '*/*', limit: options.config.requestBodyLimit }),
    handler,
  );

  return router;
}
