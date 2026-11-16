import { loadEnv, type AppConfig } from '../../src/config/env';

/**
 * Build application configuration for a database-backed integration test.
 *
 * The generated Prisma client loads the repository `.env` file when it is
 * imported, so `process.env` inside a test process also contains the
 * developer's local provider configuration. Integration tests must never
 * contact a real mail, storage or payment provider, and a partially
 * configured local value (for example an empty `OBJECT_STORAGE_ENDPOINT`
 * next to a real bucket name) must not make an unrelated suite fail
 * validation.
 *
 * This helper keeps the runner-provided database and Redis URLs while
 * pinning provider settings to inert test values. A suite that genuinely
 * needs a provider passes an explicit override.
 */
export function loadTestConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadEnv({
    ...process.env,
    OBJECT_STORAGE_ENDPOINT: '',
    OBJECT_STORAGE_BUCKET: '',
    OBJECT_STORAGE_ACCESS_KEY_ID: '',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: '',
    EMAIL_PROVIDER: 'console',
    ...overrides,
  });
}
