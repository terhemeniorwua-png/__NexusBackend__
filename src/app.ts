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
import { createPaystackWebhookRouter } from './modules/billing/paystack-webhook.routes';
import { createGoogleOAuthCallbackRouter } from './modules/auth/google-oauth.routes';
import { createDevIntegrationCallbackRouter } from './modules/dev-integrations/dev-integration.routes';
import { createGithubWebhookRouter } from './modules/dev-integrations/github-webhook.routes';
import { createGitlabWebhookRouter } from './modules/dev-integrations/gitlab-webhook.routes';
import { createApiRouter } from './routes';
import type { RateLimitRedisClient } from './services/cache/rate-limit-store';
import type { IntegrationPickerService } from './modules/integrations/integration-picker.service';
import { createReadinessProbe, type ReadinessProbe } from './services/health';
import type { QueueStatusProbe } from './services/workers/queue-status';
import {
  createWorkerHealthRegistry,
  type WorkerHealthRegistry,
} from './services/workers/worker-health';
import { logger as defaultLogger, type Logger } from './utils/logger';
import { externalFilesRouter } from './integrations/files/routes';

export interface CreateAppOptions {
  config?: AppConfig;
  readinessProbe?: ReadinessProbe;
  logger?: Logger;
  /** Injectable for tests. Production uses the shared Redis client. */
  rateLimitClient?: RateLimitRedisClient;
  /** Process-local worker liveness. A fresh empty registry is used by default. */
  workerHealth?: WorkerHealthRegistry;
  /** Durable queue depth. Production wires the Prisma probe in `server.ts`. */
  queueStatusProbe?: QueueStatusProbe;
  /** Injectable for tests; production builds the Prisma-backed picker. */
  integrationPickerService?: IntegrationPickerService;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const config = options.config ?? loadEnv();
  const appLogger = options.logger ?? defaultLogger;
  const readinessProbe = options.readinessProbe ?? createReadinessProbe(config);
  const workerHealth =
    options.workerHealth ??
    createWorkerHealthRegistry({ staleAfterMs: config.workerHealthStaleMs });

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
  app.use(`${config.apiPrefix}/webhooks`, createPaystackWebhookRouter({ config }));
  app.use(`${config.apiPrefix}/webhooks`, createGithubWebhookRouter({ config }));
  app.use(`${config.apiPrefix}/webhooks`, createGitlabWebhookRouter({ config }));

  if (config.googleCallbackUrl) {
    app.use(new URL(config.googleCallbackUrl).pathname, createGoogleOAuthCallbackRouter(config));
  }

  if (config.githubAppCallbackUrl) {
    try {
      app.use(new URL(config.githubAppCallbackUrl).pathname, createDevIntegrationCallbackRouter({ config }));
    } catch {
      // invalid URL ignored; standard API route remains available
    }
  }

  if (config.gitlabCallbackUrl) {
    try {
      app.use(new URL(config.gitlabCallbackUrl).pathname, createDevIntegrationCallbackRouter({ config }));
    } catch {
      // invalid URL ignored; standard API route remains available
    }
  }

  app.use(
    express.json({
      limit: config.requestBodyLimit,
      strict: true,
      type: ['application/json', 'application/*+json'],
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: config.requestBodyLimit }));
  app.use('/api/files', externalFilesRouter); // matches your existing API prefix
  
  app.use(
    config.apiPrefix,
    createApiRouter({
      config,
      readinessProbe,
      workerHealth,
      ...(options.queueStatusProbe ? { queueStatusProbe: options.queueStatusProbe } : {}),
      ...(options.integrationPickerService
        ? { integrationPickerService: options.integrationPickerService }
        : {}),
    }),
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler(appLogger, config));

  return app;
}
