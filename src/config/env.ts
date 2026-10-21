import 'dotenv/config';
import { z } from 'zod';

const nodeEnvironments = ['development', 'test', 'production'] as const;
const logLevels = ['debug', 'info', 'warn', 'error', 'silent'] as const;

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .default(false);

const envSchema = z
  .object({
    NODE_ENV: z.enum(nodeEnvironments).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    DATABASE_URL: z
      .string()
      .trim()
      .min(1, 'DATABASE_URL is required')
      .url('DATABASE_URL must be a valid URL')
      .refine(
        (value) => value.startsWith('postgresql://') || value.startsWith('postgres://'),
        'DATABASE_URL must use the postgresql:// or postgres:// protocol',
      ),
    REDIS_URL: z
      .string()
      .trim()
      .min(1, 'REDIS_URL is required')
      .url('REDIS_URL must be a valid URL')
      .refine(
        (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
        'REDIS_URL must use the redis:// or rediss:// protocol',
      ),
    CORS_ORIGINS: z.string().default(''),
    FRONTEND_URL: z.string().default(''),
    CORS_CREDENTIALS: booleanString,
    LOG_LEVEL: z.enum(logLevels).default('info'),
    REQUEST_BODY_LIMIT: z
      .string()
      .regex(/^\d+(?:b|kb|mb)$/i, 'REQUEST_BODY_LIMIT must be a size such as 1mb')
      .default('1mb'),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    TRUST_PROXY: booleanString,
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    DB_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
    REDIS_HEALTH_TIMEOUT_MS: z.coerce.number().int().positive().default(3_000),
    APP_NAME: z.string().trim().min(1).default('Nexus'),
    APP_VERSION: z.string().trim().min(1).default('0.1.0'),

    // --- Authentication (Phase 3) -------------------------------------------
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters')
      .refine(
        (value) => !value.includes('change-me') && !value.includes('changeme'),
        'JWT_ACCESS_SECRET must not be a placeholder value',
      ),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().max(86_400).default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(31_536_000)
      .default(2_592_000),
    BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
    VERIFICATION_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(604_800).default(3_600),
    PASSWORD_RESET_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(604_800)
      .default(1_800),
    EMAIL_CHANGE_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(604_800).default(3_600),
    AUTH_COOKIE_SECURE: booleanString,
    AUTH_COOKIE_SAME_SITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    AUTH_COOKIE_DOMAIN: z.string().trim().default(''),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
    AUTH_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    AUTH_REGISTER_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    AUTH_PASSWORD_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
    AUTH_VERIFICATION_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),

    // Frontend routes that receive the single-use links. They are configurable
    // so the frontend contract can change without a backend deployment.
    AUTH_VERIFICATION_LINK_PATH: z.string().trim().startsWith('/').default('/verify-email'),
    AUTH_PASSWORD_RESET_LINK_PATH: z.string().trim().startsWith('/').default('/reset-password'),
    AUTH_EMAIL_CHANGE_LINK_PATH: z.string().trim().startsWith('/').default('/settings/email'),

    // Prefix for Redis keys. Environments that share a Redis instance must use
    // different namespaces so their rate-limit counters stay separate.
    RATE_LIMIT_NAMESPACE: z
      .string()
      .trim()
      .min(1)
      .regex(
        /^[a-zA-Z0-9:_-]+$/,
        'RATE_LIMIT_NAMESPACE may only contain letters, digits, ":" "_" and "-"',
      )
      .default('nexus'),
  })
  .superRefine((values, ctx) => {
    if (values.AUTH_COOKIE_SAME_SITE === 'none' && !values.AUTH_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_COOKIE_SAME_SITE'],
        message: 'AUTH_COOKIE_SAME_SITE=none requires AUTH_COOKIE_SECURE=true',
      });
    }

    if (values.NODE_ENV === 'production' && !values.FRONTEND_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['FRONTEND_URL'],
        message: 'FRONTEND_URL is required in production to build verification links',
      });
    }

    if (values.NODE_ENV === 'production' && values.FRONTEND_URL) {
      try {
        const url = new URL(values.FRONTEND_URL);

        if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
          ctx.addIssue({
            code: 'custom',
            path: ['FRONTEND_URL'],
            message: 'FRONTEND_URL must use https in production',
          });
        }
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: ['FRONTEND_URL'],
          message: 'FRONTEND_URL must be an absolute URL',
        });
      }
    }
  });

export interface AppConfig {
  nodeEnv: (typeof nodeEnvironments)[number];
  isProduction: boolean;
  isTest: boolean;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  corsOrigins: string[];
  corsCredentials: boolean;
  frontendUrl: string;
  logLevel: (typeof logLevels)[number];
  requestBodyLimit: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
  trustProxy: boolean;
  shutdownTimeoutMs: number;
  dbHealthTimeoutMs: number;
  redisHealthTimeoutMs: number;
  appName: string;
  appVersion: string;
  apiPrefix: string;
  jwtAccessSecret: string;
  jwtAccessTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  bcryptSaltRounds: number;
  verificationTokenTtlSeconds: number;
  passwordResetTokenTtlSeconds: number;
  emailChangeTokenTtlSeconds: number;
  cookieSecure: boolean;
  cookieSameSite: 'lax' | 'strict' | 'none';
  cookieDomain: string;
  authRateLimitWindowMs: number;
  authLoginRateLimitMax: number;
  authRegisterRateLimitMax: number;
  authPasswordRateLimitMax: number;
  authVerificationRateLimitMax: number;
  authVerificationLinkPath: string;
  authPasswordResetLinkPath: string;
  authEmailChangeLinkPath: string;
  rateLimitNamespace: string;
}

export class ConfigurationError extends Error {
  readonly issues: Array<{ field: string; message: string }>;

  constructor(message: string, issues: Array<{ field: string; message: string }> = []) {
    super(message);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

function parseOrigins(raw: string): string[] {
  const origins = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      try {
        return new URL(value).origin;
      } catch {
        throw new ConfigurationError(`Invalid CORS origin: ${value}`);
      }
    });

  return [...new Set(origins)];
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || 'environment',
      message: issue.message,
    }));

    throw new ConfigurationError(
      `Invalid environment configuration: ${issues.map((issue) => `${issue.field} ${issue.message}`).join('; ')}`,
      issues,
    );
  }

  const values = result.data;
  const corsOrigins = [...parseOrigins(values.CORS_ORIGINS), ...parseOrigins(values.FRONTEND_URL)];

  return {
    nodeEnv: values.NODE_ENV,
    isProduction: values.NODE_ENV === 'production',
    isTest: values.NODE_ENV === 'test',
    port: values.PORT,
    databaseUrl: values.DATABASE_URL,
    redisUrl: values.REDIS_URL,
    corsOrigins: [...new Set(corsOrigins)],
    corsCredentials: values.CORS_CREDENTIALS,
    frontendUrl: values.FRONTEND_URL,
    logLevel: values.LOG_LEVEL,
    requestBodyLimit: values.REQUEST_BODY_LIMIT,
    rateLimitWindowMs: values.RATE_LIMIT_WINDOW_MS,
    rateLimitMax: values.RATE_LIMIT_MAX,
    trustProxy: values.TRUST_PROXY,
    shutdownTimeoutMs: values.SHUTDOWN_TIMEOUT_MS,
    dbHealthTimeoutMs: values.DB_HEALTH_TIMEOUT_MS,
    redisHealthTimeoutMs: values.REDIS_HEALTH_TIMEOUT_MS,
    appName: values.APP_NAME,
    appVersion: values.APP_VERSION,
    apiPrefix: '/api/v1',
    jwtAccessSecret: values.JWT_ACCESS_SECRET,
    jwtAccessTtlSeconds: values.JWT_ACCESS_TTL_SECONDS,
    refreshTokenTtlSeconds: values.REFRESH_TOKEN_TTL_SECONDS,
    bcryptSaltRounds: values.BCRYPT_SALT_ROUNDS,
    verificationTokenTtlSeconds: values.VERIFICATION_TOKEN_TTL_SECONDS,
    passwordResetTokenTtlSeconds: values.PASSWORD_RESET_TOKEN_TTL_SECONDS,
    emailChangeTokenTtlSeconds: values.EMAIL_CHANGE_TOKEN_TTL_SECONDS,
    cookieSecure: values.AUTH_COOKIE_SECURE || values.NODE_ENV === 'production',
    cookieSameSite: values.AUTH_COOKIE_SAME_SITE,
    cookieDomain: values.AUTH_COOKIE_DOMAIN,
    authRateLimitWindowMs: values.AUTH_RATE_LIMIT_WINDOW_MS,
    authLoginRateLimitMax: values.AUTH_LOGIN_RATE_LIMIT_MAX,
    authRegisterRateLimitMax: values.AUTH_REGISTER_RATE_LIMIT_MAX,
    authPasswordRateLimitMax: values.AUTH_PASSWORD_RATE_LIMIT_MAX,
    authVerificationRateLimitMax: values.AUTH_VERIFICATION_RATE_LIMIT_MAX,
    authVerificationLinkPath: values.AUTH_VERIFICATION_LINK_PATH,
    authPasswordResetLinkPath: values.AUTH_PASSWORD_RESET_LINK_PATH,
    authEmailChangeLinkPath: values.AUTH_EMAIL_CHANGE_LINK_PATH,
    rateLimitNamespace: values.RATE_LIMIT_NAMESPACE,
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const withTestDefaults =
    source.NODE_ENV === 'test'
      ? {
          DATABASE_URL: 'postgresql://nexus:nexus@localhost:5432/nexus_test',
          REDIS_URL: 'redis://localhost:6379/15',
          LOG_LEVEL: 'silent',
          FRONTEND_URL: 'http://localhost:3000',
          JWT_ACCESS_SECRET: 'test-only-access-secret-do-not-use-in-production',
          ...source,
        }
      : source;

  return parseEnv(withTestDefaults);
}
