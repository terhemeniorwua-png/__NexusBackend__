import type { RequestHandler } from 'express';
import type { AppConfig } from '../config/env';
import { AppError } from '../utils/errors';

const allowedMethods = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const allowedHeaders = 'Content-Type, Authorization, X-Request-Id';

export function createCorsMiddleware(
  config: Pick<AppConfig, 'corsOrigins' | 'corsCredentials'>,
): RequestHandler {
  const allowedOrigins = new Set(config.corsOrigins);

  return (req, res, next) => {
    const origin = req.headers.origin;

    if (!origin) {
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }

      next();
      return;
    }

    res.vary('Origin');

    let normalizedOrigin: string;

    try {
      normalizedOrigin = new URL(origin).origin;
    } catch {
      next(new AppError(403, 'CORS_ORIGIN_DENIED', 'The request origin is not allowed'));
      return;
    }

    if (!allowedOrigins.has(normalizedOrigin)) {
      next(new AppError(403, 'CORS_ORIGIN_DENIED', 'The request origin is not allowed'));
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
    res.setHeader('Access-Control-Allow-Methods', allowedMethods);
    res.setHeader('Access-Control-Allow-Headers', allowedHeaders);
    res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id');
    res.setHeader('Access-Control-Max-Age', '600');

    if (config.corsCredentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}
