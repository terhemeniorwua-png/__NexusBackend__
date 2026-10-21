import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigurationError, parseEnv } from '../src/config/env';

const baseEnv: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  PORT: '4000',
  DATABASE_URL: 'postgresql://nexus:nexus@localhost:5432/nexus',
  REDIS_URL: 'redis://localhost:6379',
  CORS_ORIGINS: 'https://app.example.com,https://admin.example.com/login',
  FRONTEND_URL: 'https://app.example.com',
  CORS_CREDENTIALS: 'false',
  LOG_LEVEL: 'info',
  REQUEST_BODY_LIMIT: '1mb',
  RATE_LIMIT_WINDOW_MS: '60000',
  RATE_LIMIT_MAX: '300',
  TRUST_PROXY: 'false',
  SHUTDOWN_TIMEOUT_MS: '10000',
  DB_HEALTH_TIMEOUT_MS: '3000',
  REDIS_HEALTH_TIMEOUT_MS: '3000',
  APP_NAME: 'Nexus',
  APP_VERSION: '0.1.0',
};

test('parseEnv returns normalized configuration', () => {
  const config = parseEnv(baseEnv);

  assert.equal(config.port, 4000);
  assert.equal(config.apiPrefix, '/api/v1');
  assert.equal(config.isProduction, false);
  assert.equal(config.corsCredentials, false);
  assert.deepEqual(config.corsOrigins, ['https://app.example.com', 'https://admin.example.com']);
});

test('parseEnv rejects a missing database URL', () => {
  const env = { ...baseEnv };
  delete env.DATABASE_URL;

  assert.throws(
    () => parseEnv(env),
    (error) =>
      error instanceof ConfigurationError &&
      error.issues.some((issue) => issue.field === 'DATABASE_URL'),
  );
});

test('parseEnv rejects an invalid port and non-PostgreSQL database URL', () => {
  assert.throws(() => parseEnv({ ...baseEnv, PORT: '70000' }), ConfigurationError);
  assert.throws(
    () => parseEnv({ ...baseEnv, DATABASE_URL: 'mysql://localhost:3306/nexus' }),
    ConfigurationError,
  );
});

test('parseEnv rejects an invalid CORS origin', () => {
  assert.throws(() => parseEnv({ ...baseEnv, CORS_ORIGINS: 'not a url' }), ConfigurationError);
});
