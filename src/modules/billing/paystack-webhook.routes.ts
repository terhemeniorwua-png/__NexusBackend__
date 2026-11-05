import { createHash } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import type { AppConfig } from '../../config/env';
import { getPrismaClient } from '../../db/prisma';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import type { Logger } from '../../utils/logger';
import { logger as defaultLogger } from '../../utils/logger';
import { createBillingService, type BillingService } from './billing.service';
import { verifyPaystackSignature, verifyPaystackWebhookSignature } from './paystack.client';

export function createPaystackWebhookRouter(options: {
  config: AppConfig;
  prisma?: PrismaClient;
  service?: BillingService;
  logger?: Logger;
}): Router {
  const router = Router();
  const prisma = options.prisma ?? getPrismaClient();
  const service = options.service ?? createBillingService(options.config, { prisma });
  const log = options.logger ?? defaultLogger;

  router.post(
    '/paystack',
    express.raw({ type: '*/*', limit: options.config.requestBodyLimit }),
    async (req: Request, res: Response) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      if (!raw.length)
        throw new AppError(400, 'WEBHOOK_EMPTY_BODY', 'The webhook payload is empty');
      const signingSecrets = [
        options.config.paystackWebhookSecret,
        options.config.paystackWebhookPreviousSecret,
      ].filter(Boolean);
      const timestampedSignatureValid = verifyPaystackWebhookSignature(
        raw,
        req.get('paystack-signature'),
        signingSecrets,
      );
      // Keep the legacy signature only during a provider header migration.
      // New deployments should use a dedicated webhook signing secret.
      const legacySignatureValid =
        !req.get('paystack-signature') &&
        verifyPaystackSignature(
          raw,
          req.get('x-paystack-signature'),
          options.config.paystackSecretKey,
        );
      if (!timestampedSignatureValid && !legacySignatureValid) {
        throw new AppError(
          401,
          'WEBHOOK_SIGNATURE_INVALID',
          'The payment webhook signature is not valid',
        );
      }
      let payload: {
        event?: unknown;
        data?: {
          reference?: unknown;
          transaction?: { reference?: unknown; amount?: unknown; currency?: unknown };
          subscription_code?: unknown;
          subscription?: { subscription_code?: unknown };
        };
      };
      try {
        payload = JSON.parse(raw.toString('utf8')) as typeof payload;
      } catch {
        throw new AppError(400, 'WEBHOOK_INVALID_JSON', 'The payment webhook payload is invalid');
      }
      if (typeof payload.event !== 'string' || !payload.data || typeof payload.data !== 'object') {
        throw new AppError(
          400,
          'WEBHOOK_INVALID_PAYLOAD',
          'The payment webhook payload is invalid',
        );
      }
      const eventKey = createHash('sha256').update(raw).digest('hex');
      try {
        await service.processWebhook({
          event: payload.event,
          eventKey,
          reference:
            typeof payload.data.reference === 'string'
              ? payload.data.reference
              : typeof payload.data.transaction?.reference === 'string'
                ? payload.data.transaction.reference
                : undefined,
          subscriptionCode:
            typeof payload.data.subscription_code === 'string'
              ? payload.data.subscription_code
              : typeof payload.data.subscription?.subscription_code === 'string'
                ? payload.data.subscription.subscription_code
                : undefined,
          amount:
            typeof (payload.data as { amount?: unknown }).amount === 'number'
              ? (payload.data as { amount: number }).amount
              : typeof payload.data.transaction?.amount === 'number'
                ? payload.data.transaction.amount
                : undefined,
          currency:
            typeof (payload.data as { currency?: unknown }).currency === 'string'
              ? (payload.data as { currency: string }).currency
              : typeof payload.data.transaction?.currency === 'string'
                ? payload.data.transaction.currency
                : undefined,
          paidAt:
            typeof (payload.data as { paid_at?: unknown }).paid_at === 'string'
              ? (payload.data as { paid_at: string }).paid_at
              : undefined,
        });
      } catch (error) {
        log.error('paystack_webhook_processing_failed', { event: payload.event, eventKey, error });
        throw error;
      }
      res.status(200).json({ success: true, data: { received: true } });
    },
  );
  return router;
}
