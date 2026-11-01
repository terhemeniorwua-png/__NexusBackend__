import express, { type Express } from 'express';
import helmet from 'helmet';
import { loadEnv, type AppConfig } from './config/env';
import { createCorsMiddleware } from './middleware/cors';
import { createErrorHandler } from './middleware/error-handler';
import { notFoundHandler } from './middleware/not-found';
import { createRateLimiter } from './middleware/rate-limit';
import { createRequestLogger } from './middleware/request-logger';
import { requestId } from './middleware/request-id';
import { createEmailWebhookRouter } from './modules/webhooks/email-webhook.routes';
import { createApiRouter } from './routes';
import type { RateLimitRedisClient } from './services/cache/rate-limit-store';
import { createReadinessProbe, type ReadinessProbe } from './services/health';
import { logger as defaultLogger, type Logger } from './utils/logger';

export interface CreateAppOptions {
  config?: AppConfig;
  readinessProbe?: ReadinessProbe;
  logger?: Logger;
  /** Injectable for tests. Production uses the shared Redis client. */
  rateLimitClient?: RateLimitRedisClient;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const config = options.config ?? loadEnv();
  const appLogger = options.logger ?? defaultLogger;
  const readinessProbe = options.readinessProbe ?? createReadinessProbe(config);

  appLogger.setLevel(config.logLevel);

  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);

  app.use(requestId);
  app.use(createRequestLogger(appLogger));
  app.use(helmet());
  app.use(createCorsMiddleware(config));

  app.use(
    createRateLimiter({
      namespace: `${config.rateLimitNamespace}:global`,
      windowMs: config.rateLimitWindowMs,
      limit: config.rateLimitMax,
      client: options.rateLimitClient,
      skip: (req) => {
        const healthPath = `${config.apiPrefix}/health`;

        return req.path === healthPath || req.path.startsWith(`${healthPath}/`);
      },
    }),
  );

  // The provider webhook is mounted before the JSON body parser, because the
  // signature is calculated over the raw request body.
  app.use(`${config.apiPrefix}/webhooks`, createEmailWebhookRouter({ config }));

  app.use(
    express.json({
      limit: config.requestBodyLimit,
      strict: true,
      type: ['application/json', 'application/*+json'],
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: config.requestBodyLimit }));

  app.use(config.apiPrefix, createApiRouter({ config, readinessProbe }));

  app.use(notFoundHandler);
  app.use(createErrorHandler(appLogger, config));

  return app;
}
