import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTestDatabaseUrl } from './helpers/test-database';

function withEnvironment<T>(values: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('database tests never fall back to DATABASE_URL', () => {
  const result = withEnvironment({
    RUN_PHASE3_DB_TESTS: 'true',
    TEST_DATABASE_URL: undefined,
    DATABASE_URL: 'postgresql://localhost/nexus_test',
  }, () => resolveTestDatabaseUrl());
  assert.equal(result, null);
});

test('database tests accept only an explicit loopback test database', () => {
  const result = withEnvironment({
    RUN_PHASE3_DB_TESTS: 'true',
    TEST_DATABASE_URL: 'postgresql://localhost:5432/nexus_phase3_test',
  }, () => resolveTestDatabaseUrl());
  assert.equal(result, 'postgresql://localhost:5432/nexus_phase3_test');
});

test('database tests refuse remote or non-test database identities', () => {
  assert.throws(() => withEnvironment({
    RUN_PHASE3_DB_TESTS: 'true',
    TEST_DATABASE_URL: 'postgresql://db.example.com:5432/nexus_test',
  }, () => resolveTestDatabaseUrl()));
  assert.throws(() => withEnvironment({
    RUN_PHASE3_DB_TESTS: 'true',
    TEST_DATABASE_URL: 'postgresql://localhost:5432/nexus',
  }, () => resolveTestDatabaseUrl()));
});
