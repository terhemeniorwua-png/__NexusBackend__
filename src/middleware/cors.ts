import cors, { type CorsOptions } from 'cors';
import type { RequestHandler } from 'express';
import type { AppConfig } from '../config/env';
import { AppError } from '../utils/errors';

const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const allowedHeaders = ['Content-Type', 'Authorization', 'X-Request-Id'];

export function createCorsMiddleware(
  config: Pick<AppConfig, 'corsOrigins' | 'corsCredentials'>,
): RequestHandler {
  const allowedOrigins = new Set(config.corsOrigins);
  const options: CorsOptions = {
    origin(origin, callback) {
      if (!origin) {
        callback(null, false);
        return;
      }

      let normalizedOrigin: string;

      try {
        normalizedOrigin = new URL(origin).origin;
      } catch {
        callback(new AppError(403, 'CORS_ORIGIN_DENIED', 'The request origin is not allowed'));
        return;
      }

      if (!allowedOrigins.has(normalizedOrigin)) {
        callback(new AppError(403, 'CORS_ORIGIN_DENIED', 'The request origin is not allowed'));
        return;
      }

      callback(null, normalizedOrigin);
    },
    methods: allowedMethods,
    allowedHeaders,
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
    credentials: config.corsCredentials,
    optionsSuccessStatus: 204,
  };
  const corsHandler = cors(options);

  return (req, res, next) => {
    // Requests without an Origin header are not browser CORS requests. Keep
    // preflight handling explicit without granting them wildcard access.
    if (!req.headers.origin) {
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }

      next();
      return;
    }

    // Vary denied responses too, so a cache cannot reuse an origin-specific
    // CORS response for another caller.
    res.vary('Origin');
    corsHandler(req, res, next);
  };
}
