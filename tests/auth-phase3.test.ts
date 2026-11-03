import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { Express } from 'express';
import { createApp } from '../src/app';
import { parseEnv, type AppConfig } from '../src/config/env';
import { getPrismaClient } from '../src/db/prisma';
import { hashSecret } from '../src/utils/crypto';
import { processPendingAccountDeletions } from '../src/modules/auth/account-deletion.service';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import {
  resetEmailSender,
  setEmailSender,
  type EmailMessage,
  type EmailSender,
} from '../src/services/email';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import {
  CookieJar,
  jsonRequest,
  startServer,
  withServer,
  type RunningServer,
} from './helpers/test-server';

/**
 * Phase 3 account lifecycle.
 *
 * The suite exercises the real HTTP surface against a real PostgreSQL
 * database. It only runs when the database is explicitly marked as a test
 * database, because it creates and deletes accounts.
 */

class CapturingEmailSender implements EmailSender {
  readonly messages: EmailMessage[] = [];

  async send(message: EmailMessage) {
    this.messages.push(message);

    return { accepted: true, providerMessageId: `test-${this.messages.length}` };
  }

  lastFor(to: string, template?: EmailMessage['template']): EmailMessage | undefined {
    return [...this.messages].reverse().find((message) => {
      if (message.to !== to) {
        return false;
      }

      return template ? message.template === template : true;
    });
  }

  tokenFrom(message: EmailMessage | undefined): string {
    assert.ok(message, 'Expected an email to have been sent');

    const match = /token=([A-Za-z0-9_-]+)/.exec(message.text);
    const token = match?.[1];

    assert.ok(token, 'Expected the email to contain a single-use token');

    return token;
  }
}

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE3_DB_TESTS=true and a test DATABASE_URL to run this suite';

try {
  databaseUrl = resolveTestDatabaseUrl();

  if (databaseUrl) {
    skipReason = '';
  }
} catch (error) {
  skipReason = error instanceof Error ? error.message : 'The test database could not be resolved';
}

const namespace = `nexus-test-${process.pid}-${Date.now()}`;

function buildConfig(overrides: Record<string, string> = {}): AppConfig {
  return parseEnv({
    NODE_ENV: 'test',
    PORT: '4000',
    DATABASE_URL: databaseUrl as string,
    REDIS_URL: 'redis://localhost:6379/15',
    FRONTEND_URL: 'http://localhost:3000',
    CORS_ORIGINS: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    JWT_ACCESS_SECRET: 'phase3-integration-test-access-secret-value',
    BCRYPT_SALT_ROUNDS: '4',
    RATE_LIMIT_MAX: '100000',
    AUTH_LOGIN_RATE_LIMIT_MAX: '1000',
    AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    AUTH_PASSWORD_RATE_LIMIT_MAX: '1000',
    AUTH_VERIFICATION_RATE_LIMIT_MAX: '1000',
    RATE_LIMIT_NAMESPACE: namespace,
    ...overrides,
  });
}

let uniqueCounter = 0;

function uniqueEmail(prefix = 'user'): string {
  uniqueCounter += 1;

  return `${prefix}.${process.pid}.${uniqueCounter}.${Date.now()}@example.com`;
}

interface AuthenticatedSession {
  email: string;
  password: string;
  accessToken: string;
  csrfToken: string;
  refreshToken: string;
  sessionId: string;
  userId: string;
}

describe('Phase 3 account lifecycle', { skip: skipReason || false }, () => {
  const sender = new CapturingEmailSender();
  let app: Express;
  let baseUrl: string;
  let server: RunningServer;
  let prisma: ReturnType<typeof getPrismaClient>;

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);

    prisma = getPrismaClient(database.url);

    try {
      await connectRedis({ redisUrl: 'redis://localhost:6379/15' });
    } catch {
      // The rate-limit store falls back to an in-process counter.
    }

    setEmailSender(sender);

    app = createApp({ config: buildConfig() });

    server = await startServer(app);
    baseUrl = server.baseUrl;
  });

  after(async () => {
    resetEmailSender();
    await server?.close();
    await disconnectRedis();
    await prisma?.$disconnect();
  });

  async function register(
    email = uniqueEmail(),
    password = 'Correct-Horse-9',
    name = 'Test Person',
  ): Promise<{ email: string; password: string; userId: string }> {
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ email, name, password }),
    });

    assert.equal(response.status, 201, JSON.stringify(response.body));

    const userId = (response.body.data as { user: { id: string } }).user.id;

    return { email, password, userId };
  }

  async function verifyAccount(email: string): Promise<string> {
    const message = sender.lastFor(email, 'account_verification');
    const token = sender.tokenFrom(message);

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/verify-email`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));

    return token;
  }

  async function login(email: string, password = 'Correct-Horse-9'): Promise<AuthenticatedSession> {
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));

    const data = response.body.data as {
      user: { id: string };
      accessToken: string;
      csrfToken: string;
      session: { id: string };
    };

    const refreshToken =
      response.response.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('nexus_rt='))
        ?.split(';')[0]
        ?.split('=')[1] ?? '';

    return {
      email,
      password,
      accessToken: data.accessToken,
      csrfToken: data.csrfToken,
      refreshToken: decodeURIComponent(refreshToken),
      sessionId: data.session.id,
      userId: data.user.id,
    };
  }

  async function activate(): Promise<AuthenticatedSession> {
    const account = await register();
    await verifyAccount(account.email);

    return login(account.email, account.password);
  }

  async function deactivate(session: AuthenticatedSession): Promise<void> {
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/deactivate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ currentPassword: session.password }),
    });

    assert.equal(response.status, 204, JSON.stringify(response.body));
  }

  async function requestAccountDeletion(session: AuthenticatedSession) {
    return jsonRequest(`${baseUrl}/api/v1/auth/delete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ currentPassword: session.password, confirmation: session.email }),
    });
  }

  async function createOwnedWorkspace(
    userId: string,
    input: { status?: 'ACTIVE' | 'ARCHIVED'; deletedAt?: Date | null } = {},
  ): Promise<string> {
    uniqueCounter += 1;

    const workspace = await prisma.workspace.create({
      data: {
        name: `Ownership test ${uniqueCounter}`,
        slug: `ownership-test-${userId}-${uniqueCounter}`,
        ownerId: userId,
        ...(input.status ? { status: input.status } : {}),
        ...(input.deletedAt !== undefined ? { deletedAt: input.deletedAt } : {}),
      },
    });

    return workspace.id;
  }

  async function createWorkspaceThroughApi(
    session: AuthenticatedSession,
    name: string,
  ): Promise<string> {
    const response = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ name }),
    });

    assert.equal(response.status, 201, JSON.stringify(response.body));

    return (response.body.data as { id: string }).id;
  }

  async function waitForLockWaiter(queryFragment: string, expectedCount = 1): Promise<void> {
    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      const [result] = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS "count"
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE ${`%${queryFragment}%`}
      `;

      if (Number(result?.count ?? 0n) >= expectedCount) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.fail(`Timed out waiting for a database query containing ${queryFragment}`);
  }

  async function withAccountRowLocked(
    userId: string,
    action: (releaseLock: () => void) => Promise<void>,
  ): Promise<void> {
    let signalAcquired!: () => void;
    let releaseLock!: () => void;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const transaction = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
        signalAcquired();
        await held;
      },
      { timeout: 15_000 },
    );

    await acquired;

    try {
      await action(releaseLock);
    } finally {
      releaseLock();
      await transaction;
    }
  }

  async function withSessionRowLocked(
    sessionId: string,
    action: (releaseLock: () => void) => Promise<void>,
  ): Promise<void> {
    let signalAcquired!: () => void;
    let releaseLock!: () => void;
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const transaction = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${sessionId} FOR UPDATE`;
        signalAcquired();
        await held;
      },
      { timeout: 15_000 },
    );

    await acquired;

    try {
      await action(releaseLock);
    } finally {
      releaseLock();
      await transaction;
    }
  }

  async function assertDeletionIsBlockedWithoutSideEffects(
    session: AuthenticatedSession,
  ): Promise<void> {
    const response = await requestAccountDeletion(session);

    assert.equal(response.status, 409);
    assert.equal(response.body.error?.code, 'ORGANIZATION_OWNERSHIP_TRANSFER_REQUIRED');

    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    const storedSession = await prisma.session.findUnique({ where: { id: session.sessionId } });

    assert.equal(user?.status, 'ACTIVE');
    assert.equal(user?.deletedAt, null);
    assert.equal(storedSession?.revokedAt, null);

    const authenticated = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    assert.equal(authenticated.status, 200);
  }

  test('registration creates a pending account and sends a verification email', async () => {
    const email = uniqueEmail();

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ email, name: 'Ada Lovelace', password: 'Correct-Horse-9' }),
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.success, true);

    const data = response.body.data as { user: { status: string; emailVerifiedAt: null } };

    assert.equal(data.user.status, 'PENDING_VERIFICATION');
    assert.equal(data.user.emailVerifiedAt, null);

    const message = sender.lastFor(email, 'account_verification');

    assert.ok(message, 'A verification email should have been sent');
    assert.match(message.text, /token=/);
    assert.equal(
      message.text.includes('Correct-Horse-9'),
      false,
      'The email must never contain the password',
    );
  });

  test('registration rejects a duplicate email address', async () => {
    const account = await register();

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({
        email: account.email,
        name: 'Someone Else',
        password: 'Correct-Horse-9',
      }),
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error?.code, 'EMAIL_ALREADY_REGISTERED');
  });

  test('registration rejects a weak password', async () => {
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail(), name: 'Weak Pass', password: 'password' }),
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error?.code, 'VALIDATION_ERROR');
  });

  test('registration rejects unknown fields so a role cannot be smuggled in', async () => {
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({
        email: uniqueEmail(),
        name: 'Sneaky User',
        password: 'Correct-Horse-9',
        role: 'OWNER',
      }),
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error?.code, 'VALIDATION_ERROR');
  });

  test('an unverified account cannot reach protected endpoints', async () => {
    const account = await register();
    const session = await login(account.email, account.password);

    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    assert.equal(me.status, 200, 'The session itself is valid for a pending account');

    const profile = await jsonRequest(`${baseUrl}/api/v1/users/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    assert.equal(profile.status, 403);
    assert.equal(profile.body.error?.code, 'EMAIL_NOT_VERIFIED');
  });

  test('the verification token activates the account and cannot be reused', async () => {
    const account = await register();
    const token = await verifyAccount(account.email);

    const reuse = await jsonRequest(`${baseUrl}/api/v1/auth/verify-email`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });

    assert.equal(reuse.status, 400);
    assert.equal(reuse.body.error?.code, 'TOKEN_ALREADY_USED');

    const stored = await prisma.user.findUnique({ where: { id: account.userId } });

    assert.equal(stored?.status, 'ACTIVE');
    assert.ok(stored?.emailVerifiedAt);
    const personalWorkspace = await prisma.workspace.findFirst({
      where: { ownerId: account.userId, isPersonal: true },
      include: { members: true },
    });
    assert.ok(personalWorkspace);
    assert.equal(personalWorkspace.type, 'INDIVIDUAL');
    assert.equal(personalWorkspace.visibility, 'PRIVATE');
    assert.equal(personalWorkspace.members.length, 1);
    assert.equal(personalWorkspace.members[0]?.role, 'OWNER');

    const session = await login(account.email, account.password);
    const archivePersonal = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${personalWorkspace.id}/archive`,
      { method: 'POST', headers: { authorization: `Bearer ${session.accessToken}` } },
    );
    assert.equal(archivePersonal.status, 409);
    assert.equal(archivePersonal.body.error?.code, 'PERSONAL_WORKSPACE_LIFECYCLE_MANAGED');
    const deletePersonal = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${personalWorkspace.id}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${session.accessToken}` } },
    );
    assert.equal(deletePersonal.status, 409);
  });

  test('an unknown verification token is rejected', async () => {
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/verify-email`, {
      method: 'POST',
      body: JSON.stringify({ token: 'x'.repeat(43) }),
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error?.code, 'TOKEN_INVALID');
  });

  test('signing in returns an access token and sets the session cookies', async () => {
    const account = await register();
    await verifyAccount(account.email);

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email: account.email, password: account.password }),
    });

    assert.equal(response.status, 200);

    const data = response.body.data as {
      accessToken: string;
      tokenType: string;
      expiresIn: number;
      csrfToken: string;
      user: { status: string };
    };

    assert.equal(data.tokenType, 'Bearer');
    assert.ok(data.expiresIn > 0);
    assert.equal(data.user.status, 'ACTIVE');

    const cookies = response.response.headers.getSetCookie();
    const refreshCookie = cookies.find((cookie) => cookie.startsWith('nexus_rt='));
    const csrfCookie = cookies.find((cookie) => cookie.startsWith('nexus_csrf='));

    assert.ok(refreshCookie, 'The refresh token must be set as a cookie');
    assert.ok(refreshCookie.includes('HttpOnly'));
    assert.ok(refreshCookie.includes('SameSite=Lax'));
    assert.ok(csrfCookie, 'The CSRF token must be set as a cookie');
    assert.equal(csrfCookie.includes('HttpOnly'), false);
  });

  test('signing in with the wrong password is rejected', async () => {
    const account = await register();
    await verifyAccount(account.email);

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email: account.email, password: 'Wrong-Password-9' }),
    });

    assert.equal(response.status, 401);
    assert.equal(response.body.error?.code, 'INVALID_CREDENTIALS');
  });

  test('signing in with an unknown address returns the same error', async () => {
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('ghost'), password: 'Correct-Horse-9' }),
    });

    assert.equal(response.status, 401);
    assert.equal(response.body.error?.code, 'INVALID_CREDENTIALS');
  });

  test('a protected endpoint rejects a missing or malformed access token', async () => {
    const missing = await jsonRequest(`${baseUrl}/api/v1/auth/me`);

    assert.equal(missing.status, 401);
    assert.equal(missing.body.error?.code, 'AUTHENTICATION_REQUIRED');

    const malformed = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: 'Bearer not-a-jwt' },
    });

    assert.equal(malformed.status, 401);
    assert.equal(malformed.body.error?.code, 'ACCESS_TOKEN_INVALID');
  });

  test('refreshing rotates the refresh token and returns a new access token', async () => {
    const session = await activate();

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));

    const data = response.body.data as { accessToken: string };

    // The access token is a stateless JWT, so it can be identical when the
    // refresh happens within the same second. The refresh token always rotates.
    const claims = JSON.parse(
      Buffer.from(data.accessToken.split('.')[1] as string, 'base64url').toString('utf8'),
    ) as { sub: string; sid: string; typ: string };

    assert.equal(claims.sub, session.userId);
    assert.equal(claims.sid, session.sessionId);
    assert.equal(claims.typ, 'access');

    const rotated = response.response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('nexus_rt='))
      ?.split(';')[0]
      ?.split('=')[1];

    assert.ok(rotated);
    assert.notEqual(decodeURIComponent(rotated), session.refreshToken);
  });

  test('an expired refresh token is rejected without changing session state', async () => {
    const session = await activate();
    const original = await prisma.session.findUniqueOrThrow({ where: { id: session.sessionId } });

    await prisma.session.update({
      where: { id: session.sessionId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });

    assert.equal(response.status, 401);
    assert.equal(response.body.error?.code, 'SESSION_EXPIRED');

    const stored = await prisma.session.findUniqueOrThrow({ where: { id: session.sessionId } });
    assert.equal(stored.refreshTokenHash, original.refreshTokenHash);
    assert.equal(stored.previousRefreshTokenHash, null);
  });

  test('a revoked session and an unknown refresh state are rejected', async () => {
    const session = await activate();

    await prisma.session.update({
      where: { id: session.sessionId },
      data: { revokedAt: new Date(), revokedReason: 'TEST_REVOCATION' },
    });

    const revoked = await jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });

    assert.equal(revoked.status, 401);
    assert.equal(revoked.body.error?.code, 'SESSION_REUSE_DETECTED');

    const unknown = await jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: 'unknown-refresh-token-value' }),
    });

    assert.equal(unknown.status, 401);
    assert.equal(unknown.body.error?.code, 'REFRESH_TOKEN_INVALID');
  });

  test('concurrent refresh requests consume the original token state only once', async () => {
    const session = await activate();
    let first: Awaited<ReturnType<typeof jsonRequest>> | undefined;
    let second: Awaited<ReturnType<typeof jsonRequest>> | undefined;

    await withSessionRowLocked(session.sessionId, async (releaseLock) => {
      const requestRefresh = () =>
        jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
          method: 'POST',
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });
      const firstRequest = requestRefresh();
      const secondRequest = requestRefresh();

      // Both requests have read the original state and are waiting to update
      // the same PostgreSQL row before the lock is released.
      // Prisma's generated SQL may qualify the table with its schema, so
      // match the table name instead of relying on an exact query prefix.
      await waitForLockWaiter('Session', 2);
      releaseLock();
      [first, second] = await Promise.all([firstRequest, secondRequest]);
    });

    assert.ok(first);
    assert.ok(second);
    const responses = [first, second];
    assert.equal(responses.filter((response) => response.status === 200).length, 1);
    const loser = responses.find((response) => response.status === 401);
    const winner = responses.find((response) => response.status === 200);

    assert.ok(winner);
    assert.equal(loser?.body.error?.code, 'SESSION_REUSE_DETECTED');

    const winnerToken = winner.response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('nexus_rt='))
      ?.split(';')[0]
      ?.split('=')[1];
    assert.ok(winnerToken);

    const stored = await prisma.session.findUniqueOrThrow({ where: { id: session.sessionId } });
    assert.equal(stored.refreshTokenHash, hashSecret(decodeURIComponent(winnerToken)));
    assert.equal(stored.previousRefreshTokenHash, hashSecret(session.refreshToken));
    // The established replay policy revokes the family when the losing
    // request is recognised as reuse, without overwriting its winning hash.
    assert.equal(stored.revokedReason, 'REFRESH_TOKEN_REUSE');
  });

  test('a database failure during rotation returns no replacement token', async () => {
    const session = await activate();

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION nexus_test_fail_refresh_rotation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF OLD."id" = '${session.sessionId}' AND NEW."refreshTokenHash" <> OLD."refreshTokenHash" THEN
          RAISE EXCEPTION 'simulated refresh rotation failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER nexus_test_fail_refresh_rotation
      BEFORE UPDATE ON "Session"
      FOR EACH ROW
      EXECUTE FUNCTION nexus_test_fail_refresh_rotation()
    `);

    try {
      const response = await jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });

      assert.equal(response.status, 500);
      assert.equal(
        response.response.headers.getSetCookie().some((cookie) => cookie.startsWith('nexus_rt=')),
        false,
      );

      const stored = await prisma.session.findUniqueOrThrow({ where: { id: session.sessionId } });
      assert.equal(stored.refreshTokenHash, hashSecret(session.refreshToken));
      assert.equal(stored.previousRefreshTokenHash, null);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER nexus_test_fail_refresh_rotation ON "Session"`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION nexus_test_fail_refresh_rotation()`);
    }
  });

  test('replaying a rotated refresh token revokes every session', async () => {
    const session = await activate();

    const first = await jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });

    assert.equal(first.status, 200);

    const replay = await jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });

    assert.equal(replay.status, 401);
    assert.equal(replay.body.error?.code, 'SESSION_REUSE_DETECTED');

    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    assert.equal(me.status, 401, 'Every session of the account must be revoked');
  });

  test('a cookie authenticated refresh requires the CSRF token', async () => {
    const session = await activate();

    const jar = new CookieJar();

    jar.set('nexus_rt', session.refreshToken);

    const withoutToken = await jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      jar,
    });

    assert.equal(withoutToken.status, 403);
    assert.equal(withoutToken.body.error?.code, 'CSRF_TOKEN_INVALID');

    // The CSRF cookie alone must not be enough. A browser attaches cookies to
    // cross-site requests automatically, so accepting the cookie would defeat
    // the check it is supposed to perform.
    const cookieOnly = new CookieJar();

    cookieOnly.set('nexus_rt', session.refreshToken);
    cookieOnly.set('nexus_csrf', session.csrfToken);

    const withCookieOnly = await jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      jar: cookieOnly,
    });

    assert.equal(withCookieOnly.status, 403);
    assert.equal(withCookieOnly.body.error?.code, 'CSRF_TOKEN_INVALID');

    const withToken = await jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      jar,
      headers: { 'x-csrf-token': session.csrfToken },
    });

    assert.equal(withToken.status, 200, JSON.stringify(withToken.body));
  });

  test('signing out invalidates the access token immediately', async () => {
    const session = await activate();

    const before = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    assert.equal(before.status, 200);

    const logout = await jsonRequest(`${baseUrl}/api/v1/auth/logout`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });

    assert.equal(logout.status, 204);

    const after = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    assert.equal(after.status, 401);
  });

  test('signing out of every device revokes all sessions', async () => {
    const session = await activate();
    const second = await login(session.email, session.password);

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/logout-all`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    assert.equal(response.status, 204);

    for (const token of [session.accessToken, second.accessToken]) {
      const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(me.status, 401);
    }
  });

  test('the active sessions of the account are listed', async () => {
    const session = await activate();
    await login(session.email, session.password);

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/sessions`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    assert.equal(response.status, 200);

    const data = response.body.data as { sessions: Array<{ id: string; current: boolean }> };

    assert.equal(data.sessions.length, 2);
    assert.equal(data.sessions.filter((entry) => entry.current).length, 1);
  });

  test('a password reset revokes every existing session', async () => {
    const session = await activate();

    const requested = await jsonRequest(`${baseUrl}/api/v1/auth/password/forgot`, {
      method: 'POST',
      body: JSON.stringify({ email: session.email }),
    });

    assert.equal(requested.status, 200);

    const token = sender.tokenFrom(sender.lastFor(session.email, 'password_reset'));

    const reset = await jsonRequest(`${baseUrl}/api/v1/auth/password/reset`, {
      method: 'POST',
      body: JSON.stringify({ token, password: 'Brand-New-Secret-7' }),
    });

    assert.equal(reset.status, 200, JSON.stringify(reset.body));

    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    assert.equal(me.status, 401);

    const oldPassword = await jsonRequest(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email: session.email, password: session.password }),
    });

    assert.equal(oldPassword.status, 401);

    const newPassword = await jsonRequest(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email: session.email, password: 'Brand-New-Secret-7' }),
    });

    assert.equal(newPassword.status, 200);
  });

  test('asking for a password reset does not reveal whether the address exists', async () => {
    const known = await jsonRequest(`${baseUrl}/api/v1/auth/password/forgot`, {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('unknown') }),
    });

    const existing = await jsonRequest(`${baseUrl}/api/v1/auth/password/forgot`, {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('unknown') }),
    });

    assert.equal(known.status, 200);
    assert.equal(existing.status, 200);
    assert.deepEqual(known.body.data, existing.body.data);
  });

  test('changing the password keeps the current session and revokes the others', async () => {
    const session = await activate();
    const other = await login(session.email, session.password);

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/password/change`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        currentPassword: session.password,
        newPassword: 'Another-Good-Pass-4',
      }),
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));

    const current = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    assert.equal(current.status, 200);

    const revoked = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${other.accessToken}` },
    });

    assert.equal(revoked.status, 401);
  });

  test('changing the password requires the current password', async () => {
    const session = await activate();

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/password/change`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        currentPassword: 'Not-The-Password-3',
        newPassword: 'Another-Good-Pass-4',
      }),
    });

    assert.equal(response.status, 401);
    assert.equal(response.body.error?.code, 'INVALID_CREDENTIALS');
  });

  test('the email address is changed only after the new address is confirmed', async () => {
    const session = await activate();
    const newEmail = uniqueEmail('changed');

    const requested = await jsonRequest(`${baseUrl}/api/v1/auth/email/change`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ email: newEmail, currentPassword: session.password }),
    });

    assert.equal(requested.status, 200, JSON.stringify(requested.body));

    const beforeConfirm = await prisma.user.findUnique({ where: { id: session.userId } });

    assert.equal(beforeConfirm?.email, session.email);

    const token = sender.tokenFrom(sender.lastFor(newEmail, 'email_change_verification'));

    const confirmed = await jsonRequest(`${baseUrl}/api/v1/auth/email/change/confirm`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });

    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

    const afterConfirm = await prisma.user.findUnique({ where: { id: session.userId } });

    assert.equal(afterConfirm?.email, newEmail);
  });

  test('an email change to an address that is already registered is rejected', async () => {
    const session = await activate();
    const other = await register();

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/email/change`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ email: other.email, currentPassword: session.password }),
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error?.code, 'EMAIL_ALREADY_REGISTERED');
  });

  test('the profile is read and updated', async () => {
    const session = await activate();

    const read = await jsonRequest(`${baseUrl}/api/v1/users/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    assert.equal(read.status, 200);

    const data = read.body.data as {
      user: { email: string; name: string };
      profile: { timeZone: string };
    };

    assert.equal(data.user.email, session.email);
    assert.equal(data.user.name, 'Test Person');
    assert.equal(data.profile.timeZone, 'UTC');

    const updated = await jsonRequest(`${baseUrl}/api/v1/users/me`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        name: 'Renamed Person',
        jobTitle: 'Engineer',
        timeZone: 'Europe/London',
      }),
    });

    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    const profile = updated.body.data as {
      user: { name: string };
      profile: { jobTitle: string; timeZone: string };
    };

    assert.equal(profile.user.name, 'Renamed Person');
    assert.equal(profile.profile.jobTitle, 'Engineer');
    assert.equal(profile.profile.timeZone, 'Europe/London');
  });

  test('deactivating the account blocks sign-in and revokes the sessions', async () => {
    const session = await activate();

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/deactivate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ currentPassword: session.password }),
    });

    assert.equal(response.status, 204);

    const login = await jsonRequest(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email: session.email, password: session.password }),
    });

    assert.equal(login.status, 403);
    assert.equal(login.body.error?.code, 'ACCOUNT_DEACTIVATED');
  });

  test('a deactivation transaction failure leaves account and session state unchanged', async () => {
    const session = await activate();

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION nexus_test_fail_deactivation_session_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW."revokedReason" = 'ACCOUNT_DEACTIVATED' THEN
          RAISE EXCEPTION 'simulated session revocation failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER nexus_test_fail_deactivation_session_update
      BEFORE UPDATE ON "Session"
      FOR EACH ROW
      EXECUTE FUNCTION nexus_test_fail_deactivation_session_update()
    `);

    try {
      const response = await jsonRequest(`${baseUrl}/api/v1/auth/deactivate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ currentPassword: session.password }),
      });

      assert.equal(response.status, 500);

      const stored = await prisma.user.findUnique({ where: { id: session.userId } });
      const storedSession = await prisma.session.findUnique({ where: { id: session.sessionId } });

      assert.equal(stored?.status, 'ACTIVE');
      assert.equal(storedSession?.revokedAt, null);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER nexus_test_fail_deactivation_session_update ON "Session"`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION nexus_test_fail_deactivation_session_update()`);
    }
  });

  test('reactivation restores the account but never restores its old sessions', async () => {
    const session = await activate();

    await deactivate(session);

    const oldAccessBefore = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    assert.equal(oldAccessBefore.status, 401);

    const oldRefreshBefore = await jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });

    assert.equal(oldRefreshBefore.status, 401);
    assert.equal(oldRefreshBefore.body.error?.code, 'SESSION_REUSE_DETECTED');

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/reactivate`, {
      method: 'POST',
      body: JSON.stringify({ email: session.email, password: session.password }),
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));

    const data = response.body.data as {
      user: { status: string };
      accessToken?: string;
      session?: unknown;
    };

    assert.equal(data.user.status, 'ACTIVE');
    assert.equal(data.accessToken, undefined, 'Reactivation must not create an access token');
    assert.equal(data.session, undefined, 'Reactivation must not create a session');

    const stored = await prisma.user.findUnique({ where: { id: session.userId } });

    assert.equal(stored?.status, 'ACTIVE');
    assert.equal(stored?.deletedAt, null);

    const oldAccessAfter = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });

    assert.equal(oldAccessAfter.status, 401);

    const oldRefreshAfter = await jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });

    assert.equal(oldRefreshAfter.status, 401);

    const newSession = await login(session.email, session.password);
    const newAccess = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${newSession.accessToken}` },
    });

    assert.equal(newAccess.status, 200);

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'auth.account_reactivated', actorId: session.userId },
    });

    assert.ok(audit, 'Reactivation has to be recorded in the audit log');
  });

  test('reactivating an already active account is rejected', async () => {
    const session = await activate();

    const activeSessionsBefore = await prisma.session.count({
      where: { userId: session.userId, revokedAt: null },
    });

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/reactivate`, {
      method: 'POST',
      body: JSON.stringify({ email: session.email, password: session.password }),
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error?.code, 'ACCOUNT_ALREADY_ACTIVE');

    const stored = await prisma.user.findUnique({ where: { id: session.userId } });

    assert.equal(stored?.status, 'ACTIVE');

    const activeSessionsAfter = await prisma.session.count({
      where: { userId: session.userId, revokedAt: null },
    });

    assert.equal(activeSessionsAfter, activeSessionsBefore);

    const failure = await prisma.auditLog.findFirst({
      where: {
        action: 'auth.account_reactivation_failed',
        actorId: session.userId,
        targetId: session.userId,
      },
      orderBy: { createdAt: 'desc' },
    });

    assert.equal(
      failure?.metadata && (failure.metadata as { reason?: string }).reason,
      'ACCOUNT_ALREADY_ACTIVE',
    );
  });

  test('a suspended account cannot reactivate itself', async () => {
    const session = await activate();

    await prisma.user.update({
      where: { id: session.userId },
      data: { status: 'SUSPENDED' },
    });

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/reactivate`, {
      method: 'POST',
      body: JSON.stringify({ email: session.email, password: session.password }),
    });

    assert.equal(response.status, 403);
    assert.equal(response.body.error?.code, 'ACCOUNT_SUSPENDED');

    const stored = await prisma.user.findUnique({ where: { id: session.userId } });

    assert.equal(stored?.status, 'SUSPENDED');

    const failure = await prisma.auditLog.findFirst({
      where: {
        action: 'auth.account_reactivation_failed',
        actorId: session.userId,
        targetId: session.userId,
      },
      orderBy: { createdAt: 'desc' },
    });

    assert.equal(
      failure?.metadata && (failure.metadata as { reason?: string }).reason,
      'ACCOUNT_SUSPENDED',
    );
  });

  test('an unverified account that was never deactivated cannot reactivate', async () => {
    const account = await register();

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/reactivate`, {
      method: 'POST',
      body: JSON.stringify({ email: account.email, password: account.password }),
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error?.code, 'ACCOUNT_NOT_DEACTIVATED');

    const stored = await prisma.user.findUnique({ where: { id: account.userId } });

    assert.equal(stored?.status, 'PENDING_VERIFICATION');

    const failure = await prisma.auditLog.findFirst({
      where: {
        action: 'auth.account_reactivation_failed',
        actorId: account.userId,
        targetId: account.userId,
      },
      orderBy: { createdAt: 'desc' },
    });

    assert.equal(
      failure?.metadata && (failure.metadata as { reason?: string }).reason,
      'ACCOUNT_NOT_DEACTIVATED',
    );
  });

  test('a pending deletion requires password recovery and does not restore old sessions', async () => {
    const session = await activate();

    const deleted = await requestAccountDeletion(session);

    assert.equal(deleted.status, 202, JSON.stringify(deleted.body));

    const storedPending = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
    assert.equal(storedPending.status, 'PENDING_DELETION');
    assert.equal(storedPending.deletedAt, null);
    assert.ok(storedPending.deletionRequestedAt);
    assert.ok(storedPending.scheduledDeletionAt);
    assert.equal(
      storedPending.scheduledDeletionAt.getTime() - storedPending.deletionRequestedAt.getTime(),
      30 * 24 * 60 * 60 * 1_000,
    );

    const loginBlocked = await jsonRequest(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email: session.email, password: session.password }),
    });
    assert.equal(loginBlocked.status, 403);
    assert.equal(loginBlocked.body.error?.code, 'ACCOUNT_PENDING_DELETION');

    const oldSession = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(oldSession.status, 401);

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/reactivate`, {
      method: 'POST',
      body: JSON.stringify({ email: session.email, password: session.password }),
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));

    const stored = await prisma.user.findUnique({ where: { id: session.userId } });

    assert.equal(stored?.status, 'ACTIVE');
    assert.equal(stored?.deletionRequestedAt, null);
    assert.equal(stored?.scheduledDeletionAt, null);

    const oldSessionAgain = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(oldSessionAgain.status, 401);

    const newLogin = await login(session.email, session.password);
    assert.notEqual(newLogin.sessionId, session.sessionId);
  });

  test('reactivation does not reveal account state to an invalid credential', async () => {
    const session = await activate();

    await deactivate(session);

    const wrongPassword = await jsonRequest(`${baseUrl}/api/v1/auth/reactivate`, {
      method: 'POST',
      body: JSON.stringify({ email: session.email, password: 'Wrong-Password-9' }),
    });

    const unknownAccount = await jsonRequest(`${baseUrl}/api/v1/auth/reactivate`, {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('ghost'), password: session.password }),
    });

    assert.equal(wrongPassword.status, 401);
    assert.equal(wrongPassword.body.error?.code, 'INVALID_CREDENTIALS');
    assert.equal(unknownAccount.status, 401);
    assert.equal(unknownAccount.body.error?.code, 'INVALID_CREDENTIALS');
    assert.equal(wrongPassword.body.error?.message, unknownAccount.body.error?.message);

    const stored = await prisma.user.findUnique({ where: { id: session.userId } });

    assert.equal(stored?.status, 'DEACTIVATED');
  });

  test('reactivation validates the email address and password', async () => {
    const invalidEmail = await jsonRequest(`${baseUrl}/api/v1/auth/reactivate`, {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email', password: 'Correct-Horse-9' }),
    });

    const missingPassword = await jsonRequest(`${baseUrl}/api/v1/auth/reactivate`, {
      method: 'POST',
      body: JSON.stringify({ email: uniqueEmail('reactivation') }),
    });

    assert.equal(invalidEmail.status, 400);
    assert.equal(invalidEmail.body.error?.code, 'VALIDATION_ERROR');
    assert.equal(missingPassword.status, 400);
    assert.equal(missingPassword.body.error?.code, 'VALIDATION_ERROR');
  });

  test('reactivating an unverified account returns it to pending verification', async () => {
    const account = await register();
    const oldVerificationToken = sender.tokenFrom(
      sender.lastFor(account.email, 'account_verification'),
    );
    const session = await login(account.email, account.password);

    await deactivate(session);

    const oldVerification = await jsonRequest(`${baseUrl}/api/v1/auth/verify-email`, {
      method: 'POST',
      body: JSON.stringify({ token: oldVerificationToken }),
    });

    assert.equal(oldVerification.status, 400);
    assert.equal(oldVerification.body.error?.code, 'TOKEN_ALREADY_USED');

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/reactivate`, {
      method: 'POST',
      body: JSON.stringify({ email: account.email, password: account.password }),
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));

    const data = response.body.data as { user: { status: string } };

    assert.equal(data.user.status, 'PENDING_VERIFICATION');

    const stored = await prisma.user.findUnique({ where: { id: account.userId } });

    assert.equal(stored?.status, 'PENDING_VERIFICATION');
    assert.equal(stored?.emailVerifiedAt, null);

    await verifyAccount(account.email);

    const verified = await prisma.user.findUnique({ where: { id: account.userId } });

    assert.equal(verified?.status, 'ACTIVE');
    assert.ok(verified?.emailVerifiedAt);

    const newSession = await login(account.email, account.password);

    assert.ok(newSession.accessToken);
  });

  test('a pre-deactivation email-change token cannot reactivate the account', async () => {
    const session = await activate();
    const newEmail = uniqueEmail('reactivation-change');

    const requested = await jsonRequest(`${baseUrl}/api/v1/auth/email/change`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ email: newEmail, currentPassword: session.password }),
    });

    assert.equal(requested.status, 200, JSON.stringify(requested.body));

    const token = sender.tokenFrom(sender.lastFor(newEmail, 'email_change_verification'));

    await deactivate(session);

    const confirmed = await jsonRequest(`${baseUrl}/api/v1/auth/email/change/confirm`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });

    assert.equal(confirmed.status, 400);
    assert.equal(confirmed.body.error?.code, 'TOKEN_ALREADY_USED');

    const stored = await prisma.user.findUnique({ where: { id: session.userId } });

    assert.equal(stored?.status, 'DEACTIVATED');
    assert.equal(stored?.email, session.email);
  });

  test('a pre-deactivation password-reset token cannot be used while deactivated', async () => {
    const session = await activate();

    const requested = await jsonRequest(`${baseUrl}/api/v1/auth/password/forgot`, {
      method: 'POST',
      body: JSON.stringify({ email: session.email }),
    });

    assert.equal(requested.status, 200);

    const token = sender.tokenFrom(sender.lastFor(session.email, 'password_reset'));

    await deactivate(session);

    const reset = await jsonRequest(`${baseUrl}/api/v1/auth/password/reset`, {
      method: 'POST',
      body: JSON.stringify({ token, password: 'Another-Good-Pass-4' }),
    });

    assert.equal(reset.status, 400);
    assert.equal(reset.body.error?.code, 'TOKEN_ALREADY_USED');

    const stored = await prisma.user.findUnique({ where: { id: session.userId } });

    assert.equal(stored?.status, 'DEACTIVATED');
  });

  test('account deletion is blocked while the account owns an active workspace', async () => {
    const session = await activate();

    await createOwnedWorkspace(session.userId, { status: 'ACTIVE' });
    await assertDeletionIsBlockedWithoutSideEffects(session);
  });

  test('account deletion is blocked while the account owns an archived workspace', async () => {
    const session = await activate();

    await createOwnedWorkspace(session.userId, { status: 'ARCHIVED' });
    await assertDeletionIsBlockedWithoutSideEffects(session);
  });

  test('account deletion checks every retained workspace status, including soft-deleted rows', async () => {
    const session = await activate();

    await createOwnedWorkspace(session.userId, { status: 'ACTIVE' });
    await createOwnedWorkspace(session.userId, { status: 'ARCHIVED' });
    await createOwnedWorkspace(session.userId, { status: 'ARCHIVED', deletedAt: new Date() });

    await assertDeletionIsBlockedWithoutSideEffects(session);
  });

  test('account deletion ignores workspaces owned by another user and workspace memberships', async () => {
    const member = await activate();
    const owner = await activate();
    const workspaceId = await createWorkspaceThroughApi(owner, 'Workspace owned by another user');

    await prisma.workspaceMembership.create({
      data: { workspaceId, userId: member.userId, role: 'MEMBER' },
    });

    const deleted = await requestAccountDeletion(member);

    assert.equal(deleted.status, 202, JSON.stringify(deleted.body));

    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });

    assert.equal(workspace?.ownerId, owner.userId);
  });

  test('account deletion is blocked when the personal workspace has collaborators', async () => {
    const owner = await activate();
    const collaborator = await activate();
    const personalWorkspace = await prisma.workspace.findFirstOrThrow({
      where: { ownerId: owner.userId, isPersonal: true },
    });
    await prisma.workspaceMembership.create({
      data: { workspaceId: personalWorkspace.id, userId: collaborator.userId, role: 'MEMBER' },
    });

    const response = await requestAccountDeletion(owner);
    assert.equal(response.status, 409);
    assert.equal(response.body.error?.code, 'PERSONAL_WORKSPACE_SHARED');
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: owner.userId } })).status,
      'ACTIVE',
    );
  });

  test('account deletion succeeds after ownership is transferred to an existing member', async () => {
    const owner = await activate();
    const nextOwner = await activate();
    const workspaceId = await createWorkspaceThroughApi(owner, 'Transfer before account deletion');

    await prisma.workspaceMembership.create({
      data: { workspaceId, userId: nextOwner.userId, role: 'MEMBER' },
    });

    const transfer = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/owner/${nextOwner.userId}`,
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${owner.accessToken}` },
        body: JSON.stringify({ newOwnerRole: 'MEMBER' }),
      },
    );

    assert.equal(transfer.status, 200, JSON.stringify(transfer.body));

    const transferred = await prisma.workspace.findUnique({ where: { id: workspaceId } });

    assert.equal(transferred?.ownerId, nextOwner.userId);

    const deleted = await requestAccountDeletion(owner);

    assert.equal(deleted.status, 202, JSON.stringify(deleted.body));
  });

  test('a failed ownership transfer leaves deletion blocked and the account usable', async () => {
    const owner = await activate();
    const other = await activate();
    const workspaceId = await createWorkspaceThroughApi(owner, 'Failed ownership resolution');

    const transfer = await jsonRequest(
      `${baseUrl}/api/v1/workspaces/${workspaceId}/owner/${other.userId}`,
      {
        method: 'PATCH',
        headers: { authorization: `Bearer ${owner.accessToken}` },
        body: JSON.stringify({ newOwnerRole: 'MEMBER' }),
      },
    );

    assert.equal(transfer.status, 404);

    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });

    assert.equal(workspace?.ownerId, owner.userId);
    await assertDeletionIsBlockedWithoutSideEffects(owner);
  });

  test('a deletion transaction failure does not partially revoke the account session', async () => {
    const session = await activate();

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION nexus_test_fail_account_deletion_session_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW."revokedReason" = 'ACCOUNT_PENDING_DELETION' THEN
          RAISE EXCEPTION 'simulated account deletion failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER nexus_test_fail_account_deletion_session_update
      BEFORE UPDATE ON "Session"
      FOR EACH ROW
      EXECUTE FUNCTION nexus_test_fail_account_deletion_session_update()
    `);

    try {
      const response = await requestAccountDeletion(session);

      assert.equal(response.status, 500);

      const user = await prisma.user.findUnique({ where: { id: session.userId } });
      const storedSession = await prisma.session.findUnique({ where: { id: session.sessionId } });

      assert.equal(user?.status, 'ACTIVE');
      assert.equal(user?.deletedAt, null);
      assert.equal(storedSession?.revokedAt, null);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER nexus_test_fail_account_deletion_session_update ON "Session"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION nexus_test_fail_account_deletion_session_update()`,
      );
    }
  });

  test('a later deletion failure rolls back successful session and token updates', async () => {
    const session = await activate();
    const resetTokenHash = hashSecret(`deletion-rollback-${session.userId}`);

    await prisma.authToken.create({
      data: {
        userId: session.userId,
        purpose: 'PASSWORD_RESET',
        tokenHash: resetTokenHash,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await prisma.userProfile.upsert({
      where: { userId: session.userId },
      create: {
        userId: session.userId,
        bio: 'Keep this profile on rollback',
        jobTitle: 'Engineer',
        avatarUrl: 'https://example.com/avatar.png',
      },
      update: {
        bio: 'Keep this profile on rollback',
        jobTitle: 'Engineer',
        avatarUrl: 'https://example.com/avatar.png',
      },
    });

    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION nexus_test_fail_account_deletion_user_update()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW."status" = 'PENDING_DELETION' THEN
          RAISE EXCEPTION 'simulated account deletion user update failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER nexus_test_fail_account_deletion_user_update
      BEFORE UPDATE ON "User"
      FOR EACH ROW
      EXECUTE FUNCTION nexus_test_fail_account_deletion_user_update()
    `);

    try {
      const response = await requestAccountDeletion(session);

      assert.equal(response.status, 500);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
      const storedSession = await prisma.session.findUniqueOrThrow({
        where: { id: session.sessionId },
      });
      const token = await prisma.authToken.findUniqueOrThrow({
        where: { tokenHash: resetTokenHash },
      });
      const profile = await prisma.userProfile.findUniqueOrThrow({
        where: { userId: session.userId },
      });

      assert.equal(user.status, 'ACTIVE');
      assert.equal(user.deletedAt, null);
      assert.equal(storedSession.revokedAt, null);
      assert.equal(storedSession.revokedReason, null);
      assert.equal(token.usedAt, null);
      assert.equal(profile.bio, 'Keep this profile on rollback');
      assert.equal(profile.jobTitle, 'Engineer');
      assert.equal(profile.avatarUrl, 'https://example.com/avatar.png');

      const authenticated = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${session.accessToken}` },
      });

      assert.equal(authenticated.status, 200);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER nexus_test_fail_account_deletion_user_update ON "User"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION nexus_test_fail_account_deletion_user_update()`,
      );
    }
  });

  test('concurrent deletion requests commit once and reject the losing request', async () => {
    const session = await activate();
    let statuses: number[] = [];

    await withAccountRowLocked(session.userId, async (releaseLock) => {
      const first = requestAccountDeletion(session);
      const second = requestAccountDeletion(session);

      await waitForLockWaiter('FOR UPDATE', 2);
      releaseLock();
      statuses = (await Promise.all([first, second])).map((response) => response.status);
    });

    assert.deepEqual(
      statuses.sort((a, b) => a - b),
      [202, 409],
    );

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
    const storedSession = await prisma.session.findUniqueOrThrow({
      where: { id: session.sessionId },
    });

    assert.equal(stored.status, 'PENDING_DELETION');
    assert.equal(stored.deletedAt, null);
    assert.ok(stored.scheduledDeletionAt);
    assert.ok(storedSession.revokedAt);
    assert.equal(storedSession.revokedReason, 'ACCOUNT_PENDING_DELETION');
  });

  test('a concurrent session refresh cannot survive committed account deletion', async () => {
    const session = await activate();
    let deletionStatus = 0;
    let refresh: Awaited<ReturnType<typeof jsonRequest>> | undefined;

    await withSessionRowLocked(session.sessionId, async (releaseLock) => {
      const deletion = requestAccountDeletion(session);
      const refreshing = jsonRequest(`${baseUrl}/api/v1/auth/refresh`, {
        method: 'POST',
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      });

      await waitForLockWaiter('Session', 2);
      releaseLock();
      const [deleted, refreshed] = await Promise.all([deletion, refreshing]);
      deletionStatus = deleted.status;
      refresh = refreshed;
    });

    assert.equal(deletionStatus, 202);
    assert.ok(refresh);
    assert.ok([200, 401, 403].includes(refresh.status));

    const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
    const storedSession = await prisma.session.findUniqueOrThrow({
      where: { id: session.sessionId },
    });

    assert.equal(user.status, 'PENDING_DELETION');
    assert.equal(user.deletedAt, null);
    assert.ok(storedSession.revokedAt);
    assert.equal(storedSession.revokedReason, 'ACCOUNT_PENDING_DELETION');

    if (refresh.status === 200) {
      const accessToken = (refresh.body.data as { accessToken: string }).accessToken;
      const authenticated = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });

      assert.equal(authenticated.status, 401);
    }
  });

  test('a concurrent workspace creation cannot attach to a deleting account', async () => {
    const session = await activate();
    let deletionStatus = 0;
    let creationStatus = 0;

    await withAccountRowLocked(session.userId, async (releaseLock) => {
      const deletion = requestAccountDeletion(session);

      await waitForLockWaiter('FOR UPDATE');

      const creation = jsonRequest(`${baseUrl}/api/v1/workspaces`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ name: 'Concurrent workspace creation' }),
      });

      await waitForLockWaiter('FOR KEY SHARE');
      releaseLock();

      const [deleted, created] = await Promise.all([deletion, creation]);

      deletionStatus = deleted.status;
      creationStatus = created.status;
    });

    assert.equal(deletionStatus, 202);
    assert.equal(creationStatus, 403);
    assert.equal(
      await prisma.workspace.count({ where: { ownerId: session.userId, isPersonal: false } }),
      0,
    );
  });

  test('a concurrent deletion prevents ownership transfer to the deleted account', async () => {
    const owner = await activate();
    const nextOwner = await activate();
    const workspaceId = await createWorkspaceThroughApi(owner, 'Concurrent ownership transfer');

    await prisma.workspaceMembership.create({
      data: { workspaceId, userId: nextOwner.userId, role: 'MEMBER' },
    });

    let deletionStatus = 0;
    let transferStatus = 0;

    await withAccountRowLocked(nextOwner.userId, async (releaseLock) => {
      const deletion = requestAccountDeletion(nextOwner);

      await waitForLockWaiter('FOR UPDATE');

      const transfer = jsonRequest(
        `${baseUrl}/api/v1/workspaces/${workspaceId}/owner/${nextOwner.userId}`,
        {
          method: 'PATCH',
          headers: { authorization: `Bearer ${owner.accessToken}` },
          body: JSON.stringify({ newOwnerRole: 'MEMBER' }),
        },
      );

      await waitForLockWaiter('FOR KEY SHARE');
      releaseLock();

      const [deleted, transferred] = await Promise.all([deletion, transfer]);

      deletionStatus = deleted.status;
      transferStatus = transferred.status;
    });

    assert.equal(deletionStatus, 202);
    assert.equal(transferStatus, 403);

    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });

    assert.equal(workspace?.ownerId, owner.userId);
  });

  test('deletion schedules 30 days of recovery without removing personal data', async () => {
    const session = await activate();

    const wrongConfirmation = await jsonRequest(`${baseUrl}/api/v1/auth/delete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({
        currentPassword: session.password,
        confirmation: 'wrong@example.com',
      }),
    });

    assert.equal(wrongConfirmation.status, 400);
    assert.equal(wrongConfirmation.body.error?.code, 'CONFIRMATION_MISMATCH');

    const response = await jsonRequest(`${baseUrl}/api/v1/auth/delete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.accessToken}` },
      body: JSON.stringify({ currentPassword: session.password, confirmation: session.email }),
    });

    assert.equal(response.status, 202, JSON.stringify(response.body));

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
    const personalWorkspace = await prisma.workspace.findFirstOrThrow({
      where: { ownerId: session.userId, isPersonal: true },
    });
    const storedSession = await prisma.session.findUniqueOrThrow({
      where: { id: session.sessionId },
    });

    assert.equal(stored.name, 'Test Person');
    assert.equal(stored.email, session.email);
    assert.equal(stored.status, 'PENDING_DELETION');
    assert.equal(stored.deletedAt, null);
    assert.ok(stored.deletionRequestedAt);
    assert.ok(stored.scheduledDeletionAt);
    assert.equal(personalWorkspace.name, "Test Person's Personal Workspace");
    assert.ok(storedSession.revokedAt);
    assert.equal(storedSession.revokedReason, 'ACCOUNT_PENDING_DELETION');

    const deletionEmail = sender.lastFor(session.email, 'account_deletion_scheduled');
    assert.ok(deletionEmail);
    assert.match(deletionEmail.text, /30 days|30-day|scheduled for permanent deletion/i);

    const oldSessionAccess = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    assert.equal(oldSessionAccess.status, 401);

    const reRegister = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({
        email: session.email,
        name: 'Second Life',
        password: session.password,
      }),
    });
    assert.equal(reRegister.status, 409);
    assert.equal(reRegister.body.error?.code, 'EMAIL_ALREADY_REGISTERED');
  });

  test('permanent deletion removes personal records and preserves shared content', async () => {
    const member = await activate();
    const organizationOwner = await activate();
    const personalWorkspace = await prisma.workspace.findFirstOrThrow({
      where: { ownerId: member.userId, isPersonal: true },
    });
    const sharedWorkspaceId = await createWorkspaceThroughApi(
      organizationOwner,
      'Retained shared organization',
    );
    await prisma.workspaceMembership.create({
      data: {
        workspaceId: sharedWorkspaceId,
        userId: member.userId,
        role: 'OWNER',
        organizationRole: 'COMPANY_OWNER',
      },
    });

    const personalProject = await prisma.project.create({
      data: {
        workspaceId: personalWorkspace.id,
        name: 'Personal project to remove',
        key: `P${uniqueCounter + 1}`,
        ownerId: member.userId,
      },
    });
    const personalTask = await prisma.task.create({
      data: {
        projectId: personalProject.id,
        key: 'P-1',
        title: 'Personal task to remove',
        creatorId: member.userId,
      },
    });

    const sharedProject = await prisma.project.create({
      data: {
        workspaceId: sharedWorkspaceId,
        name: 'Shared project to preserve',
        key: `S${uniqueCounter + 1}`,
        ownerId: organizationOwner.userId,
      },
    });
    const sharedTask = await prisma.task.create({
      data: {
        projectId: sharedProject.id,
        key: 'S-1',
        title: 'Shared task to preserve',
        creatorId: organizationOwner.userId,
      },
    });
    await prisma.comment.create({
      data: { taskId: sharedTask.id, authorId: member.userId, body: 'Keep this shared comment' },
    });
    await prisma.fileAttachment.create({
      data: {
        workspaceId: sharedWorkspaceId,
        projectId: sharedProject.id,
        taskId: sharedTask.id,
        uploadedById: member.userId,
        fileName: 'shared.txt',
        mimeType: 'text/plain',
        sizeBytes: 16,
        storageKey: `shared/${member.userId}/${uniqueCounter + 2}`,
      },
    });
    await prisma.taskAssignee.create({
      data: { taskId: sharedTask.id, userId: member.userId, assignedBy: organizationOwner.userId },
    });

    const request = await requestAccountDeletion(member);
    assert.equal(request.status, 202, JSON.stringify(request.body));

    const dueAt = new Date(Date.now() - 1);
    await prisma.user.update({
      where: { id: member.userId },
      data: { scheduledDeletionAt: dueAt },
    });

    const processed = await processPendingAccountDeletions(prisma, new Date(), 4);
    assert.equal(processed.deleted, 1);
    assert.deepEqual(processed.blocked, []);

    const deletedUser = await prisma.user.findUniqueOrThrow({ where: { id: member.userId } });
    assert.equal(deletedUser.name, 'Deleted user');
    assert.equal(deletedUser.email, `deleted+${member.userId}@nexus.invalid`);
    assert.ok(deletedUser.deletedAt);
    assert.equal(deletedUser.passwordHash === member.password, false);
    assert.equal(await prisma.workspace.findUnique({ where: { id: personalWorkspace.id } }), null);
    assert.equal(await prisma.project.findUnique({ where: { id: personalProject.id } }), null);
    assert.equal(await prisma.task.findUnique({ where: { id: personalTask.id } }), null);

    const retainedWorkspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: sharedWorkspaceId },
    });
    const retainedComment = await prisma.comment.findFirstOrThrow({
      where: { taskId: sharedTask.id },
      include: { author: true },
    });
    assert.equal(retainedWorkspace.ownerId, organizationOwner.userId);
    assert.equal(
      await prisma.workspaceMembership.count({
        where: { workspaceId: sharedWorkspaceId, userId: member.userId },
      }),
      0,
    );
    assert.equal(retainedComment.body, 'Keep this shared comment');
    assert.equal(retainedComment.author.name, 'Deleted user');
    assert.equal(await prisma.taskAssignee.count({ where: { taskId: sharedTask.id } }), 0);
    assert.equal(
      await prisma.fileAttachment.count({ where: { workspaceId: sharedWorkspaceId } }),
      1,
    );

    const recoveryAfterPurge = await jsonRequest(`${baseUrl}/api/v1/auth/reactivate`, {
      method: 'POST',
      body: JSON.stringify({ email: member.email, password: member.password }),
    });
    assert.equal(recoveryAfterPurge.status, 401);
    assert.equal(recoveryAfterPurge.body.error?.code, 'INVALID_CREDENTIALS');

    const retry = await processPendingAccountDeletions(prisma, new Date(), 4);
    assert.equal(retry.deleted, 0);
  });

  test('permanent deletion is held when personal storage assets exist', async () => {
    const session = await activate();
    const personalWorkspace = await prisma.workspace.findFirstOrThrow({
      where: { ownerId: session.userId, isPersonal: true },
    });
    await prisma.fileAttachment.create({
      data: {
        workspaceId: personalWorkspace.id,
        uploadedById: session.userId,
        fileName: 'private.txt',
        mimeType: 'text/plain',
        sizeBytes: 10,
        storageKey: `personal/${session.userId}/${uniqueCounter + 1}`,
      },
    });
    const request = await requestAccountDeletion(session);
    assert.equal(request.status, 202);
    await prisma.user.update({
      where: { id: session.userId },
      data: { scheduledDeletionAt: new Date(Date.now() - 1) },
    });

    const result = await processPendingAccountDeletions(prisma, new Date(), 4);
    assert.equal(result.deleted, 0);
    assert.deepEqual(result.blocked, [{ userId: session.userId, reason: 'PERSONAL_FILES' }]);
    assert.ok(await prisma.workspace.findUnique({ where: { id: personalWorkspace.id } }));
    assert.equal(
      await prisma.fileAttachment.count({ where: { workspaceId: personalWorkspace.id } }),
      1,
    );
  });

  test('deletion is blocked when the user is the final active organization administrator', async () => {
    const owner = await activate();
    const administrator = await activate();
    const workspaceId = await createWorkspaceThroughApi(owner, 'Last administrator guard');
    await prisma.workspaceMembership.create({
      data: { workspaceId, userId: administrator.userId, role: 'PROJECT_MANAGER' },
    });
    await prisma.user.update({
      where: { id: owner.userId },
      data: { status: 'DEACTIVATED' },
    });

    const response = await requestAccountDeletion(administrator);
    assert.equal(response.status, 409);
    assert.equal(response.body.error?.code, 'LAST_ORGANIZATION_ADMIN');
    assert.equal(
      (await prisma.user.findUniqueOrThrow({ where: { id: administrator.userId } })).status,
      'ACTIVE',
    );
  });

  test('sign-in attempts are rate limited', async () => {
    const limitedConfig = buildConfig({
      AUTH_LOGIN_RATE_LIMIT_MAX: '3',
      RATE_LIMIT_NAMESPACE: `${namespace}-limited`,
    });

    const limitedApp = createApp({ config: limitedConfig });

    await withServer(limitedApp, async (url) => {
      const email = uniqueEmail('bruteforce');

      let limited = false;

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await jsonRequest(`${url}/api/v1/auth/login`, {
          method: 'POST',
          body: JSON.stringify({ email, password: 'Correct-Horse-9' }),
        });

        if (response.status === 429) {
          limited = true;
          assert.equal(response.body.error?.code, 'LOGIN_RATE_LIMITED');
          break;
        }
      }

      assert.equal(limited, true, 'The login endpoint must rate limit repeated attempts');
    });
  });

  test('sign-in and account events are written to the audit log', async () => {
    const session = await activate();

    const events = await prisma.auditLog.findMany({
      where: { actorId: session.userId },
      orderBy: { createdAt: 'asc' },
    });

    const actions = events.map((event) => event.action);

    assert.ok(actions.includes('auth.account_registered'));
    assert.ok(actions.includes('auth.email_verified'));
    assert.ok(actions.includes('auth.login_succeeded'));

    assert.equal(
      events.every((event) => event.workspaceId === null),
      true,
      'Account level events are not attached to a workspace',
    );
  });
});
