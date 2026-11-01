import assert from 'node:assert/strict';
import test from 'node:test';
import { parseEnv, type AppConfig } from '../src/config/env';
import {
  emailChangeSchema,
  loginSchema,
  passwordSchema,
  registerSchema,
} from '../src/modules/auth/auth.schemas';
import { createCsrfValidator } from '../src/modules/auth/csrf';
import { updateProfileSchema } from '../src/modules/users/users.schemas';
import { createRateLimitStore } from '../src/services/cache/rate-limit-store';
import {
  assertPasswordLength,
  hashPassword,
  PASSWORD_MAX_BYTES,
  verifyPassword,
} from '../src/services/password';
import {
  deriveKey,
  generateSecureToken,
  hashSecret,
  safeCompare,
  signValue,
  TOKEN_BYTES,
} from '../src/utils/crypto';
import { parseCookies } from '../src/utils/cookies';
import { FakeRedisClient } from './helpers/fake-redis';

/**
 * Phase 3 unit tests.
 *
 * These cover the building blocks of the account lifecycle without touching
 * PostgreSQL, so they run on every `npm test`.
 */

const testConfig: AppConfig = parseEnv({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://nexus:nexus@localhost:5432/nexus_test',
  REDIS_URL: 'redis://localhost:6379/15',
  JWT_ACCESS_SECRET: 'unit-test-access-secret-value-that-is-long-enough',
});

test('the password policy rejects weak and common passwords', () => {
  assert.equal(passwordSchema.safeParse('Short1').success, false);
  assert.equal(passwordSchema.safeParse('alllettersonly').success, false);
  assert.equal(passwordSchema.safeParse('1234567890').success, false);
  assert.equal(passwordSchema.safeParse('password1').success, false);
  assert.equal(passwordSchema.safeParse('Correct-Horse-9').success, true);
});

test('the password policy rejects passwords longer than the bcrypt limit', () => {
  const tooLong = `${'a'.repeat(PASSWORD_MAX_BYTES)}1`;

  assert.ok(Buffer.byteLength(tooLong, 'utf8') > PASSWORD_MAX_BYTES);
  assert.equal(passwordSchema.safeParse(tooLong).success, false);
  assert.throws(() => assertPasswordLength(tooLong));
  assert.doesNotThrow(() => assertPasswordLength('a'.repeat(PASSWORD_MAX_BYTES - 1)));
});

test('registration normalises the email address and rejects unknown fields', () => {
  const parsed = registerSchema.parse({
    email: '  Ada@Example.COM ',
    name: 'Ada Lovelace',
    password: 'Correct-Horse-9',
  });

  assert.equal(parsed.email, 'ada@example.com');
  assert.equal(parsed.name, 'Ada Lovelace');

  assert.equal(
    registerSchema.safeParse({
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      password: 'Correct-Horse-9',
      role: 'OWNER',
    }).success,
    false,
  );
});

test('the login schema accepts any non-empty password so timing stays comparable', () => {
  assert.equal(loginSchema.safeParse({ email: 'ada@example.com', password: 'x' }).success, true);
  assert.equal(loginSchema.safeParse({ email: 'ada@example.com', password: '' }).success, false);
  assert.equal(loginSchema.safeParse({ email: 'not-an-email', password: 'x' }).success, false);
});

test('the email change schema requires the current password', () => {
  assert.equal(
    emailChangeSchema.safeParse({ email: 'new@example.com', currentPassword: 'Correct-Horse-9' })
      .success,
    true,
  );
  assert.equal(emailChangeSchema.safeParse({ email: 'new@example.com' }).success, false);
});

test('the profile schema rejects an empty update and unknown fields', () => {
  assert.equal(updateProfileSchema.safeParse({}).success, false);
  assert.equal(updateProfileSchema.safeParse({ name: 'New Name' }).success, true);
  assert.equal(updateProfileSchema.safeParse({ status: 'ACTIVE' }).success, false);
  assert.equal(updateProfileSchema.safeParse({ avatarUrl: 'javascript:alert(1)' }).success, false);
});

test('passwords are hashed with bcrypt and never stored in clear text', async () => {
  const hash = await hashPassword('Correct-Horse-9', 4);

  assert.notEqual(hash, 'Correct-Horse-9');
  assert.match(hash, /^\$2[aby]\$/);
  assert.equal(await verifyPassword('Correct-Horse-9', hash), true);
  assert.equal(await verifyPassword('Wrong-Horse-9', hash), false);
  assert.equal(await verifyPassword('Correct-Horse-9', 'not-a-hash'), false);
});

test('secure tokens are URL-safe and unique', () => {
  const tokens = new Set<string>();

  for (let index = 0; index < 200; index += 1) {
    const token = generateSecureToken();

    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.equal(Buffer.from(token, 'base64url').length, TOKEN_BYTES);
    assert.equal(tokens.has(token), false);

    tokens.add(token);
  }
});

test('secret digests are deterministic and one-way', () => {
  const digest = hashSecret('a-secret-value');

  assert.equal(digest, hashSecret('a-secret-value'));
  assert.notEqual(digest, hashSecret('another-secret-value'));
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest.includes('a-secret-value'), false);
});

test('derived keys are separated by purpose', () => {
  const csrf = deriveKey('master-secret', 'csrf');
  const other = deriveKey('master-secret', 'other');

  assert.notEqual(csrf, other);
  assert.equal(csrf, deriveKey('master-secret', 'csrf'));
  assert.notEqual(csrf, deriveKey('another-master-secret', 'csrf'));
});

test('signed values are stable and compared safely', () => {
  const key = deriveKey('master-secret', 'csrf');
  const signature = signValue(key, 'session-1');

  assert.equal(signature, signValue(key, 'session-1'));
  assert.equal(safeCompare(signature, signValue(key, 'session-1')), true);
  assert.equal(safeCompare(signature, signValue(key, 'session-2')), false);
  assert.equal(safeCompare(signature, 'a-shorter-value'), false);
  assert.equal(safeCompare(signature, ''), false);
});

test('the CSRF token only validates for the session it was issued for', () => {
  const csrf = createCsrfValidator(testConfig);
  const token = csrf.tokenFor('session-1');

  assert.equal(csrf.verify('session-1', token), true);
  assert.equal(csrf.verify('session-2', token), false);
  assert.equal(csrf.verify('session-1', undefined), false);
  assert.equal(csrf.verify('session-1', 'forged-token'), false);
});

test('cookies are parsed into a name/value map', () => {
  const cookies = parseCookies('nexus_rt=abc123; nexus_csrf=def456');

  assert.deepEqual(cookies, { nexus_rt: 'abc123', nexus_csrf: 'def456' });

  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
  assert.deepEqual(parseCookies('malformed'), {});
  assert.deepEqual(parseCookies('a=1; a=2'), { a: '1' });
  assert.deepEqual(parseCookies('encoded=a%20b'), { encoded: 'a b' });
});

test('the rate limit store counts hits and can reset a key', async () => {
  const namespace = `unit-test-${process.pid}-${Date.now()}`;
  const store = createRateLimitStore({
    namespace,
    windowMs: 60_000,
    client: new FakeRedisClient(),
  });

  const first = await store.increment('client-1');
  const second = await store.increment('client-1');
  const other = await store.increment('client-2');

  assert.equal(first.totalHits, 1);
  assert.equal(second.totalHits, 2);
  assert.equal(other.totalHits, 1);
  assert.ok(second.resetTime);
  assert.ok(second.resetTime.getTime() > Date.now());

  await store.resetKey('client-1');

  const afterReset = await store.increment('client-1');

  assert.equal(afterReset.totalHits, 1);
});
