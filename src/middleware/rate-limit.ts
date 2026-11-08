import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, RequestHandler } from 'express';
import {
  createRateLimitStore,
  type RateLimitRedisClient,
} from '../services/cache/rate-limit-store';
import { AppError } from '../utils/errors';
import { hashSecret } from '../utils/crypto';

/**
 * Rate limiting for sensitive authentication endpoints.
 *
 * Every limiter has two dimensions where it matters: a per-IP bucket that
 * stops a single host from spraying requests, and a per-account bucket that
 * stops distributed guessing of one credential. Counters are shared through
 * Redis so limits hold across backend instances.
 */

export interface RateLimiterOptions {
  namespace: string;
  windowMs: number;
  limit: number;
  code?: string;
  message?: string;
  /** Derives the bucket key. Defaults to the client IP. */
  keyGenerator?: (req: Request) => string;
  /** Skips the limiter for a request, such as the health endpoints. */
  skip?: (req: Request) => boolean | Promise<boolean>;
  /** Injectable for tests. Production uses the shared Redis client. */
  client?: RateLimitRedisClient;
}

export function createRateLimiter({
  namespace,
  windowMs,
  limit,
  code = 'RATE_LIMITED',
  message = 'Too many requests. Please try again later.',
  keyGenerator,
  skip,
  client,
}: RateLimiterOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: createRateLimitStore({ namespace, windowMs, client }),
    keyGenerator: keyGenerator ?? ((req: Request) => ipKeyGenerator(req.ip ?? 'unknown')),
    skip,
    passOnStoreError: false,
    handler: (_req, _res, next) => {
      next(new AppError(429, code, message));
    },
  });
}

function readEmail(req: Request): string {
  const body = req.body as { email?: unknown } | undefined;
  const raw = body?.email;

  if (typeof raw !== 'string') {
    return 'unknown';
  }

  return raw.trim().toLowerCase();
}

/**
 * Key generator that buckets by client IP and by the target account.
 *
 * The account component is hashed so that email addresses are not stored as
 * rate-limit keys in Redis.
 */
export function accountKeyGenerator(req: Request): string {
  const ip = ipKeyGenerator(req.ip ?? 'unknown');
  const account = hashSecret(readEmail(req));

  return `${ip}:${account}`;
}

export function emailKeyGenerator(req: Request): string {
  return hashSecret(readEmail(req));
}
