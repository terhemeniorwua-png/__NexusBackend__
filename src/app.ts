import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { loadEnv, type AppConfig } from './config/env';
import { createCorsMiddleware } from './middleware/cors';
import { createErrorHandler } from './middleware/error-handler';
import { notFoundHandler } from './middleware/not-found';
import { createRequestLogger } from './middleware/request-logger';
import { requestId } from './middleware/request-id';
import { createApiRouter } from './routes';
import { createReadinessProbe, type ReadinessProbe } from './services/health';
import { AppError } from './utils/errors';
import { logger as defaultLogger, type Logger } from './utils/logger';

export interface CreateAppOptions {
  config?: AppConfig;
  readinessProbe?: ReadinessProbe;
  logger?: Logger;
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
    rateLimit({
      windowMs: config.rateLimitWindowMs,
      limit: config.rateLimitMax,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip: (req) => req.path.startsWith(`${config.apiPrefix}/health`),
      handler: (_req, _res, next) => {
        next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.'));
      },
    }),
  );

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
