import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

/**
 * The project keeps its local environment file in `src/.env`. A deployment can
 * also provide a `.env` in the working directory, and `src/.env` has the
 * higher precedence. Values that are already present in `process.env` always
 * win, so a deployment can override every entry.
 *
 * The file is not loaded in the test environment, because the test suite
 * provides its own database, rate limit and provider configuration and must
 * never reach a real database or a real mail provider.
 */
if (process.env.NODE_ENV !== 'test') {
  loadDotenv({
    path: [path.resolve(__dirname, '..', '.env'), path.resolve(process.cwd(), '.env')],
  });
}

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

    // --- Workspaces and invitations (Phase 5) ------------------------------
    //
    // An invitation is a single use link with a deadline. The lifetime is
    // generous enough for a person to notice the mail and the path points at
    // the frontend page that shows the invitation.
    WORKSPACE_INVITATION_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .max(2_592_000)
      .default(604_800),
    WORKSPACE_INVITATION_LINK_PATH: z
      .string()
      .trim()
      .startsWith('/')
      .default('/workspaces/invitations/accept'),
    TASK_ASSIGNMENT_LINK_PATH: z
      .string()
      .trim()
      .startsWith('/')
      .refine(
        (value) => value.includes(':projectId') && value.includes(':taskId'),
        'TASK_ASSIGNMENT_LINK_PATH must include :projectId and :taskId',
      )
      .default('/projects/:projectId/tasks/:taskId'),

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

    // --- Transactional email (Phase 4) ---------------------------------------
    //
    // The transport is provider agnostic. Resend, Brevo and Amazon SES all
    // expose an SMTP endpoint, so a single adapter covers all three and only
    // the connection details change.
    EMAIL_PROVIDER: z.enum(['smtp', 'console', 'disabled']).default('console'),
    EMAIL_SMTP_HOST: z.string().trim().default(''),
    EMAIL_SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    EMAIL_SMTP_SECURE: booleanString,
    EMAIL_SMTP_USER: z.string().trim().default(''),
    EMAIL_SMTP_PASSWORD: z.string().default(''),
    EMAIL_SMTP_TLS_REJECT_UNAUTHORIZED: booleanString.default(true),
    EMAIL_FROM_ADDRESS: z
      .string()
      .trim()
      .email('EMAIL_FROM_ADDRESS must be a valid email address')
      .default('no-reply@nexus.local'),
    EMAIL_FROM_NAME: z.string().trim().default(''),
    EMAIL_REPLY_TO_ADDRESS: z
      .string()
      .trim()
      .default('')
      .refine(
        (value) => value === '' || z.string().email().safeParse(value).success,
        'EMAIL_REPLY_TO_ADDRESS must be a valid email address',
      ),
    EMAIL_SUPPORT_ADDRESS: z
      .string()
      .trim()
      .default('')
      .refine(
        (value) => value === '' || z.string().email().safeParse(value).success,
        'EMAIL_SUPPORT_ADDRESS must be a valid email address',
      ),
    // Public base URL used for links inside emails. Falls back to the
    // frontend URL when it is not set explicitly.
    EMAIL_APP_URL: z.string().trim().default(''),
    EMAIL_WEBHOOK_SECRET: z
      .string()
      .trim()
      .default('')
      .refine(
        (value) => value === '' || value.length >= 32,
        'EMAIL_WEBHOOK_SECRET must be at least 32 characters',
      ),
    // Providers that do not sign their events, Brevo among them, cannot be
    // authenticated by a signature. The webhook URL then carries this token
    // instead, so the endpoint is still protected by a shared secret.
    EMAIL_WEBHOOK_TOKEN: z
      .string()
      .trim()
      .default('')
      .refine(
        (value) => value === '' || value.length >= 32,
        'EMAIL_WEBHOOK_TOKEN must be at least 32 characters',
      ),
    EMAIL_WEBHOOK_SIGNATURE_HEADER: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9-]+$/, 'EMAIL_WEBHOOK_SIGNATURE_HEADER must be a header name')
      .default('x-nexus-signature'),
    EMAIL_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().default(300),
    EMAIL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
    EMAIL_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(30_000),
    EMAIL_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(3_600_000),
    EMAIL_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
    EMAIL_WORKER_ENABLED: booleanString.default(true),
    EMAIL_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    EMAIL_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
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

    if (values.EMAIL_PROVIDER === 'smtp') {
      if (!values.EMAIL_SMTP_HOST) {
        ctx.addIssue({
          code: 'custom',
          path: ['EMAIL_SMTP_HOST'],
          message: 'EMAIL_SMTP_HOST is required when EMAIL_PROVIDER is "smtp"',
        });
      }

      if (values.EMAIL_SMTP_PORT === 465 && !values.EMAIL_SMTP_SECURE) {
        ctx.addIssue({
          code: 'custom',
          path: ['EMAIL_SMTP_SECURE'],
          message: 'EMAIL_SMTP_SECURE must be true when EMAIL_SMTP_PORT is 465',
        });
      }
    }

    if (values.NODE_ENV === 'production' && values.EMAIL_PROVIDER !== 'smtp') {
      ctx.addIssue({
        code: 'custom',
        path: ['EMAIL_PROVIDER'],
        message: 'EMAIL_PROVIDER must be "smtp" in production',
      });
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
  workspaceInvitationTtlSeconds: number;
  workspaceInvitationLinkPath: string;
  taskAssignmentLinkPath: string;
  emailProvider: 'smtp' | 'console' | 'disabled';
  emailSmtpHost: string;
  emailSmtpPort: number;
  emailSmtpSecure: boolean;
  emailSmtpUser: string;
  emailSmtpPassword: string;
  emailSmtpTlsRejectUnauthorized: boolean;
  emailFromAddress: string;
  emailFromName: string;
  emailReplyToAddress: string;
  emailSupportAddress: string;
  emailAppUrl: string;
  emailWebhookSecret: string;
  emailWebhookToken: string;
  emailWebhookSignatureHeader: string;
  emailWebhookToleranceSeconds: number;
  emailMaxAttempts: number;
  emailRetryBaseDelayMs: number;
  emailRetryMaxDelayMs: number;
  emailRequestTimeoutMs: number;
  emailWorkerEnabled: boolean;
  emailWorkerPollIntervalMs: number;
  emailWorkerBatchSize: number;
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
    workspaceInvitationTtlSeconds: values.WORKSPACE_INVITATION_TTL_SECONDS,
    workspaceInvitationLinkPath: values.WORKSPACE_INVITATION_LINK_PATH,
    taskAssignmentLinkPath: values.TASK_ASSIGNMENT_LINK_PATH,
    emailProvider: values.EMAIL_PROVIDER,
    emailSmtpHost: values.EMAIL_SMTP_HOST,
    emailSmtpPort: values.EMAIL_SMTP_PORT,
    emailSmtpSecure: values.EMAIL_SMTP_SECURE || values.EMAIL_SMTP_PORT === 465,
    emailSmtpUser: values.EMAIL_SMTP_USER,
    emailSmtpPassword: values.EMAIL_SMTP_PASSWORD,
    emailSmtpTlsRejectUnauthorized: values.EMAIL_SMTP_TLS_REJECT_UNAUTHORIZED,
    emailFromAddress: values.EMAIL_FROM_ADDRESS,
    emailFromName: values.EMAIL_FROM_NAME || values.APP_NAME,
    emailReplyToAddress: values.EMAIL_REPLY_TO_ADDRESS,
    emailSupportAddress: values.EMAIL_SUPPORT_ADDRESS,
    emailAppUrl: (values.EMAIL_APP_URL || values.FRONTEND_URL).replace(/\/+$/, ''),
    emailWebhookSecret: values.EMAIL_WEBHOOK_SECRET,
    emailWebhookToken: values.EMAIL_WEBHOOK_TOKEN,
    emailWebhookSignatureHeader: values.EMAIL_WEBHOOK_SIGNATURE_HEADER,
    emailWebhookToleranceSeconds: values.EMAIL_WEBHOOK_TOLERANCE_SECONDS,
    emailMaxAttempts: values.EMAIL_MAX_ATTEMPTS,
    emailRetryBaseDelayMs: values.EMAIL_RETRY_BASE_DELAY_MS,
    emailRetryMaxDelayMs: values.EMAIL_RETRY_MAX_DELAY_MS,
    emailRequestTimeoutMs: values.EMAIL_REQUEST_TIMEOUT_MS,
    emailWorkerEnabled: values.EMAIL_WORKER_ENABLED,
    emailWorkerPollIntervalMs: values.EMAIL_WORKER_POLL_INTERVAL_MS,
    emailWorkerBatchSize: values.EMAIL_WORKER_BATCH_SIZE,
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
