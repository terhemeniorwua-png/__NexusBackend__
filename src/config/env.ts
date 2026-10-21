import 'dotenv/config';
import { z } from 'zod';

const nodeEnvironments = ['development', 'test', 'production'] as const;
const logLevels = ['debug', 'info', 'warn', 'error', 'silent'] as const;

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .default(false);

const envSchema = z.object({
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
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const withTestDefaults =
    source.NODE_ENV === 'test'
      ? {
          DATABASE_URL: 'postgresql://nexus:nexus@localhost:5432/nexus_test',
          REDIS_URL: 'redis://localhost:6379/15',
          LOG_LEVEL: 'silent',
          ...source,
        }
      : source;

  return parseEnv(withTestDefaults);
}
