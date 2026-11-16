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
  JWT_ACCESS_SECRET: 'test-only-access-secret-do-not-use-in-production',
  OTP_HMAC_SECRET: 'unit-test-otp-hmac-secret-value-that-is-long-enough',
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64url'),
};

test('parseEnv returns normalized configuration', () => {
  const config = parseEnv(baseEnv);

  assert.equal(config.port, 4000);
  assert.equal(config.apiPrefix, '/api/v1');
  assert.equal(config.isProduction, false);
  assert.equal(config.corsCredentials, false);
  assert.deepEqual(config.corsOrigins, ['https://app.example.com', 'https://admin.example.com']);
});

test('parseEnv supports the existing Google callback key and pipe-separated frontend origins', () => {
  const config = parseEnv({
    ...baseEnv,
    FRONTEND_URL: 'https://app.example.com || http://localhost:3000',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'server-secret',
    GOOGLE_CALLBACK_URL: 'https://frontend.example.com',
    redirect_URL: 'https://api.example.com/api/auth/google/callback',
  });

  assert.equal(config.googleCallbackUrl, 'https://api.example.com/api/auth/google/callback');
  assert.equal(config.googleClientId, 'client-id');
  assert.equal(config.googleClientSecret, 'server-secret');
  assert.equal(config.frontendUrl, 'https://app.example.com');
  assert.deepEqual(config.corsOrigins, [
    'https://app.example.com',
    'https://admin.example.com',
    'http://localhost:3000',
  ]);
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

test('parseEnv rejects a missing or weak JWT access secret', () => {
  const withoutSecret: NodeJS.ProcessEnv = { ...baseEnv };
  delete withoutSecret.JWT_ACCESS_SECRET;

  assert.throws(
    () => parseEnv(withoutSecret),
    (error) =>
      error instanceof ConfigurationError &&
      error.issues.some((issue) => issue.field === 'JWT_ACCESS_SECRET'),
  );

  assert.throws(() => parseEnv({ ...baseEnv, JWT_ACCESS_SECRET: 'too-short' }), ConfigurationError);
});

test('parseEnv requires a TOTP encryption key in production and validates its format', () => {
  assert.throws(
    () => parseEnv({ ...baseEnv, NODE_ENV: 'production', TOTP_ENCRYPTION_KEY: '' }),
    (error) =>
      error instanceof ConfigurationError &&
      error.issues.some((issue) => issue.field === 'TOTP_ENCRYPTION_KEY'),
  );
  assert.throws(
    () => parseEnv({ ...baseEnv, TOTP_ENCRYPTION_KEY: 'A'.repeat(42) }),
    ConfigurationError,
  );
});

test('parseEnv exposes the authentication settings with their defaults', () => {
  const config = parseEnv(baseEnv);

  assert.equal(config.jwtAccessTtlSeconds, 900);
  assert.equal(config.refreshTokenTtlSeconds, 2_592_000);
  assert.equal(config.bcryptSaltRounds, 12);
  assert.equal(config.verificationTokenTtlSeconds, 3_600);
  assert.equal(config.passwordResetTokenTtlSeconds, 1_800);
  assert.equal(config.emailChangeTokenTtlSeconds, 3_600);
  assert.equal(config.cookieSecure, false);
  assert.equal(config.cookieSameSite, 'lax');
  assert.equal(config.authLoginRateLimitMax, 10);
  assert.equal(config.authRegisterRateLimitMax, 5);
  assert.equal(config.frontendUrl, 'https://app.example.com');
  assert.equal(config.authVerificationLinkPath, '/verify-email');
  assert.equal(config.meetingInvitationLinkPath, '/meetings/:meetingId');
  assert.equal(config.teamInvitationLinkPath, '/teams/invitations/accept');
  assert.equal(config.projectInvitationLinkPath, '/projects/invitations/accept');
});

test('parseEnv forces secure cookies in production', () => {
  const config = parseEnv({
    ...baseEnv,
    NODE_ENV: 'production',
    EMAIL_PROVIDER: 'smtp',
    EMAIL_SMTP_HOST: 'smtp.example.com',
    AUTH_COOKIE_SECURE: 'true',
    CORS_CREDENTIALS: 'true',
  });

  assert.equal(config.cookieSecure, true);
});

test('parseEnv requires a transactional email provider in production', () => {
  assert.throws(
    () => parseEnv({ ...baseEnv, NODE_ENV: 'production' }),
    (error) =>
      error instanceof ConfigurationError &&
      error.issues.some((issue) => issue.field === 'EMAIL_PROVIDER'),
  );
});

test('parseEnv requires an SMTP host when the SMTP provider is selected', () => {
  assert.throws(
    () => parseEnv({ ...baseEnv, EMAIL_PROVIDER: 'smtp' }),
    (error) =>
      error instanceof ConfigurationError &&
      error.issues.some((issue) => issue.field === 'EMAIL_SMTP_HOST'),
  );
});

test('parseEnv exposes the email settings with their defaults', () => {
  const config = parseEnv(baseEnv);

  assert.equal(config.emailProvider, 'console');
  assert.equal(config.emailFromAddress, 'no-reply@nexus.local');
  assert.equal(config.emailFromName, 'Nexus');
  assert.equal(config.emailMaxAttempts, 5);
  assert.equal(config.emailSendingStaleMs, 300_000);
  assert.equal(config.emailWorkerEnabled, true);
  assert.equal(config.emailWebhookSignatureHeader, 'x-nexus-signature');
});

test('parseEnv defaults the workspace invitation lifetime to 48 hours', () => {
  const config = parseEnv(baseEnv);

  assert.equal(config.workspaceInvitationTtlSeconds, 172_800);
  assert.equal(config.workspaceInvitationLinkPath, '/workspaces/invitations/accept');
  assert.equal(config.workspaceJoinRequestTtlSeconds, 604_800);
  assert.equal(config.workspaceJoinLinkPath, '/workspaces/join');
});

test('parseEnv requires a frontend URL in production', () => {
  const withoutFrontend: NodeJS.ProcessEnv = { ...baseEnv, NODE_ENV: 'production' };
  delete withoutFrontend.FRONTEND_URL;

  assert.throws(
    () => parseEnv(withoutFrontend),
    (error) =>
      error instanceof ConfigurationError &&
      error.issues.some((issue) => issue.field === 'FRONTEND_URL'),
  );
});

test('parseEnv rejects SameSite=None without secure cookies', () => {
  assert.throws(
    () => parseEnv({ ...baseEnv, AUTH_COOKIE_SAME_SITE: 'none' }),
    (error) =>
      error instanceof ConfigurationError &&
      error.issues.some((issue) => issue.field === 'AUTH_COOKIE_SAME_SITE'),
  );
});

test('private object storage requires a complete credential set and safe endpoint', () => {
  assert.throws(
    () => parseEnv({ ...baseEnv, OBJECT_STORAGE_ENDPOINT: 'https://objects.example.com' }),
    (error) =>
      error instanceof ConfigurationError &&
      error.issues.some((issue) => issue.field === 'OBJECT_STORAGE_BUCKET'),
  );
  assert.throws(
    () =>
      parseEnv({
        ...baseEnv,
        OBJECT_STORAGE_ENDPOINT: 'https://user:secret@objects.example.com?token=secret',
        OBJECT_STORAGE_BUCKET: 'nexus-private',
        OBJECT_STORAGE_ACCESS_KEY_ID: 'access-key',
        OBJECT_STORAGE_SECRET_ACCESS_KEY: 'secret-key',
      }),
    (error) =>
      error instanceof ConfigurationError &&
      error.issues.some((issue) => issue.field === 'OBJECT_STORAGE_ENDPOINT'),
  );
});
