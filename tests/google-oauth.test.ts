import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import type { OAuth2Client } from 'google-auth-library';
import { parseEnv, type AppConfig } from '../src/config/env';
import type { AuthService } from '../src/modules/auth/auth.service';
import { createGoogleOAuthService } from '../src/modules/auth/google-oauth.service';
import { hashSecret } from '../src/utils/crypto';

interface StoredState {
  id: string;
  stateHash: string;
  nonceHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

interface StoredCode {
  id: string;
  codeHash: string;
  userId: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

function setup(claimOverrides: Record<string, unknown> = {}) {
  const config: AppConfig = parseEnv({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://nexus:nexus@localhost:5432/nexus_test',
    REDIS_URL: 'redis://localhost:6379/15',
    JWT_ACCESS_SECRET: 'google-oauth-test-access-secret-long-enough',
    GOOGLE_CLIENT_ID: 'nexus-test-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'server-only-test-secret',
    redirect_URL: 'https://api.example.com/api/auth/google/callback',
    FRONTEND_URL: 'https://app.example.com || http://localhost:3000',
  });
  const states: StoredState[] = [];
  const codes: StoredCode[] = [];
  let idSequence = 0;
  let loginCalls = 0;
  let oauthNonce = '';

  const prisma = {
    googleOAuthState: {
      deleteMany: async ({ where }: { where: { expiresAt: { lte: Date } } }) => {
        const before = states.length;
        for (let index = states.length - 1; index >= 0; index -= 1) {
          if (states[index]!.expiresAt <= where.expiresAt.lte) states.splice(index, 1);
        }
        return { count: before - states.length };
      },
      create: async ({ data }: { data: Omit<StoredState, 'id' | 'consumedAt'> }) => {
        const record: StoredState = { ...data, id: `state-${++idSequence}`, consumedAt: null };
        states.push(record);
        return record;
      },
      findUnique: async ({ where }: { where: { stateHash: string } }) =>
        states.find((record) => record.stateHash === where.stateHash) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; consumedAt: null; expiresAt: { gt: Date } };
        data: { consumedAt: Date };
      }) => {
        const record = states.find(
          (candidate) =>
            candidate.id === where.id &&
            candidate.consumedAt === null &&
            candidate.expiresAt > where.expiresAt.gt,
        );
        if (!record) return { count: 0 };
        record.consumedAt = data.consumedAt;
        return { count: 1 };
      },
    },
    googleOAuthLoginCode: {
      deleteMany: async ({ where }: { where: { expiresAt: { lte: Date } } }) => {
        const before = codes.length;
        for (let index = codes.length - 1; index >= 0; index -= 1) {
          if (codes[index]!.expiresAt <= where.expiresAt.lte) codes.splice(index, 1);
        }
        return { count: before - codes.length };
      },
      create: async ({ data }: { data: Omit<StoredCode, 'id' | 'consumedAt'> }) => {
        const record: StoredCode = { ...data, id: `code-${++idSequence}`, consumedAt: null };
        codes.push(record);
        return record;
      },
      findUnique: async ({ where }: { where: { codeHash: string } }) =>
        codes.find((record) => record.codeHash === where.codeHash) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; consumedAt: null; expiresAt: { gt: Date } };
        data: { consumedAt: Date };
      }) => {
        const record = codes.find(
          (candidate) =>
            candidate.id === where.id &&
            candidate.consumedAt === null &&
            candidate.expiresAt > where.expiresAt.gt,
        );
        if (!record) return { count: 0 };
        record.consumedAt = data.consumedAt;
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;

  const authService = {
    ensureGoogleAccount: async ({ subject, email }: { subject: string; email: string }) => {
      assert.equal(subject, 'google-subject-1');
      assert.equal(email, 'ada@example.com');
      return { id: 'user-1' };
    },
    loginGoogleAccount: async (userId: string) => {
      loginCalls += 1;
      return { user: { id: userId } };
    },
  } as unknown as AuthService;

  const oauth = {
    generateAuthUrl: (options: Record<string, string | string[]>) => {
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      for (const [key, value] of Object.entries(options)) {
        url.searchParams.set(key, Array.isArray(value) ? value.join(' ') : value);
      }
      oauthNonce = url.searchParams.get('nonce') ?? '';
      return url.toString();
    },
    getToken: async () => ({ tokens: { id_token: 'verified-by-test' } }),
    verifyIdToken: async () => ({
      getPayload: () => ({
        sub: 'google-subject-1',
        email: 'ada@example.com',
        email_verified: true,
        name: 'Ada Lovelace',
        nonce: oauthNonce,
        ...claimOverrides,
      }),
    }),
  } as unknown as OAuth2Client;

  const service = createGoogleOAuthService(config, authService, prisma, () => oauth);
  return { service, states, codes, oauthNonce: () => oauthNonce, loginCalls: () => loginCalls };
}

test('Google initiation requests only OIDC, email and profile and persists hashed state/nonce', async () => {
  const context = setup();
  const redirect = new URL(await context.service.initiate());

  assert.equal(redirect.origin, 'https://accounts.google.com');
  assert.equal(redirect.searchParams.get('scope'), 'openid email profile');
  assert.ok(context.states[0]);
  assert.equal(context.states[0]!.stateHash, hashSecret(redirect.searchParams.get('state')!));
  assert.equal(context.states[0]!.nonceHash, hashSecret(redirect.searchParams.get('nonce')!));
  assert.notEqual(context.states[0]!.nonceHash, context.oauthNonce());
});

test('Google callback returns a short-lived single-use code and exchange consumes it once', async () => {
  const context = setup();
  const authorization = new URL(await context.service.initiate());
  const frontendRedirect = new URL(
    await context.service.callback({
      code: 'google-authorization-code',
      state: authorization.searchParams.get('state')!,
    }),
  );
  assert.equal(frontendRedirect.origin, 'https://app.example.com');
  assert.equal(frontendRedirect.pathname, '/auth/google/callback');
  const code = frontendRedirect.searchParams.get('code');
  assert.ok(code);
  const result = await context.service.exchange(code, { ip: '127.0.0.1' });
  assert.deepEqual(result, { user: { id: 'user-1' } });
  assert.equal(context.loginCalls(), 1);
  await assert.rejects(
    context.service.exchange(code, {}),
    (error: { code?: string }) => error.code === 'OAUTH_CODE_INVALID',
  );
});

test('Google cancellation consumes and validates state before redirecting to the frontend', async () => {
  const context = setup();
  const authorization = new URL(await context.service.initiate());
  const state = authorization.searchParams.get('state')!;
  const redirect = new URL(await context.service.callback({ state, error: 'access_denied' }));
  assert.equal(redirect.searchParams.get('error'), 'OAUTH_CANCELLED');
  assert.ok(context.states[0]!.consumedAt);
  await assert.rejects(
    context.service.callback({ state, error: 'access_denied' }),
    (error: { code?: string }) => error.code === 'OAUTH_STATE_INVALID',
  );
});

test('Google callback rejects invalid state and a mismatched nonce', async () => {
  const invalidState = setup();
  await assert.rejects(
    invalidState.service.callback({ code: 'google-code', state: 'not-issued' }),
    (error: { code?: string }) => error.code === 'OAUTH_STATE_INVALID',
  );

  const invalidNonce = setup({ nonce: 'wrong-nonce' });
  const authorization = new URL(await invalidNonce.service.initiate());
  await assert.rejects(
    invalidNonce.service.callback({
      code: 'google-code',
      state: authorization.searchParams.get('state')!,
    }),
    (error: { code?: string }) => error.code === 'GOOGLE_TOKEN_INVALID',
  );
});

test('Google callback rejects expired state before contacting Google', async () => {
  const context = setup();
  const authorization = new URL(await context.service.initiate());
  context.states[0]!.expiresAt = new Date(Date.now() - 1_000);
  await assert.rejects(
    context.service.callback({
      code: 'google-code',
      state: authorization.searchParams.get('state')!,
    }),
    (error: { code?: string }) => error.code === 'OAUTH_STATE_INVALID',
  );
});

test('Google callback rejects unverified email claims', async () => {
  const context = setup({ email_verified: false });
  const authorization = new URL(await context.service.initiate());
  await assert.rejects(
    context.service.callback({
      code: 'google-code',
      state: authorization.searchParams.get('state')!,
    }),
    (error: { code?: string }) => error.code === 'GOOGLE_TOKEN_INVALID',
  );
});
