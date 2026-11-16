import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '@prisma/client';
import type { OAuth2Client } from 'google-auth-library';
import { parseEnv, type AppConfig } from '../src/config/env';
import type { AuthService } from '../src/modules/auth/auth.service';
import { createGoogleOAuthService } from '../src/modules/auth/google-oauth.service';
import { createAuthController } from '../src/modules/auth/auth.controller';
import type { GoogleOAuthService } from '../src/modules/auth/google-oauth.service';
import type { Request, Response } from 'express';
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

function setup(
  claimOverrides: Record<string, unknown> = {},
  options: { tokenError?: Error; accountError?: Error } = {},
) {
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
  let ensureCalls = 0;
  let oauthNonce = '';
  const auditEvents: Array<Record<string, unknown>> = [];

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
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => auditEvents.push(data),
    },
  } as unknown as PrismaClient;

  const authService = {
    ensureGoogleAccount: async ({ subject, email }: { subject: string; email: string }) => {
      ensureCalls += 1;
      assert.equal(subject, 'google-subject-1');
      assert.equal(email, 'ada@example.com');
      if (options.accountError) throw options.accountError;
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
    getToken: async () => {
      if (options.tokenError) throw options.tokenError;
      return { tokens: { id_token: 'verified-by-test' } };
    },
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
  return {
    service,
    states,
    codes,
    oauthNonce: () => oauthNonce,
    loginCalls: () => loginCalls,
    ensureCalls: () => ensureCalls,
    auditEvents,
    config,
  };
}

async function start(context: ReturnType<typeof setup>) {
  const { authorizationUrl, browserBinding } = await context.service.initiate();
  return { authorization: new URL(authorizationUrl), browserBinding };
}

test('Google initiation requests only OIDC, email and profile and persists hashed state/nonce', async () => {
  const context = setup();
  const { authorization: redirect } = await start(context);

  assert.equal(redirect.origin, 'https://accounts.google.com');
  assert.equal(redirect.searchParams.get('scope'), 'openid email profile');
  assert.ok(context.states[0]);
  assert.equal(context.states[0]!.stateHash, hashSecret(redirect.searchParams.get('state')!));
  assert.equal(context.states[0]!.nonceHash, hashSecret(redirect.searchParams.get('nonce')!));
  assert.notEqual(context.states[0]!.nonceHash, context.oauthNonce());
});

test('Google callback returns a short-lived single-use code and exchange consumes it once', async () => {
  const context = setup();
  const { authorization, browserBinding } = await start(context);
  const frontendRedirect = new URL(
    await context.service.callback({
      code: 'google-authorization-code',
      state: authorization.searchParams.get('state')!,
      browserBinding,
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
  const { authorization, browserBinding } = await start(context);
  const state = authorization.searchParams.get('state')!;
  const redirect = new URL(
    await context.service.callback({ state, error: 'access_denied', browserBinding }),
  );
  assert.equal(redirect.searchParams.get('error'), 'OAUTH_CANCELLED');
  assert.ok(context.states[0]!.consumedAt);
  const replay = new URL(
    await context.service.callback({ state, error: 'access_denied', browserBinding }),
  );
  assert.equal(replay.searchParams.get('error'), 'OAUTH_STATE_INVALID');
});

test('Google callback rejects invalid state and a mismatched nonce', async () => {
  const invalidState = setup();
  const invalidStateRedirect = new URL(
    await invalidState.service.callback({ code: 'google-code', state: 'not-issued' }),
  );
  assert.equal(invalidStateRedirect.searchParams.get('error'), 'OAUTH_STATE_INVALID');

  const invalidNonce = setup({ nonce: 'wrong-nonce' });
  const { authorization, browserBinding } = await start(invalidNonce);
  const invalidNonceRedirect = new URL(
    await invalidNonce.service.callback({
      code: 'google-code',
      state: authorization.searchParams.get('state')!,
      browserBinding,
    }),
  );
  assert.equal(invalidNonceRedirect.searchParams.get('error'), 'GOOGLE_TOKEN_INVALID');
});

test('Google callback rejects expired state before contacting Google', async () => {
  const context = setup();
  const { authorization, browserBinding } = await start(context);
  context.states[0]!.expiresAt = new Date(Date.now() - 1_000);
  const redirect = new URL(
    await context.service.callback({
      code: 'google-code',
      state: authorization.searchParams.get('state')!,
      browserBinding,
    }),
  );
  assert.equal(redirect.searchParams.get('error'), 'OAUTH_STATE_INVALID');
});

test('Google callback rejects unverified email claims', async () => {
  const context = setup({ email_verified: false });
  const { authorization, browserBinding } = await start(context);
  const redirect = new URL(
    await context.service.callback({
      code: 'google-code',
      state: authorization.searchParams.get('state')!,
      browserBinding,
    }),
  );
  assert.equal(redirect.searchParams.get('error'), 'GOOGLE_TOKEN_INVALID');
  assert.equal(context.ensureCalls(), 0);
});

test('Google start sets the signed browser binding as an HttpOnly ten-minute cookie', async () => {
  const context = setup();
  const controller = createAuthController({
    config: context.config,
    service: {} as AuthService,
    googleOAuth: context.service as GoogleOAuthService,
  });
  const cookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  let redirect = '';
  const response = {
    cookie: (name: string, value: string, options: Record<string, unknown>) =>
      cookies.push({ name, value, options }),
    redirect: (_status: number, url: string) => {
      redirect = url;
    },
  } as unknown as Response;
  await controller.googleStart({} as Request, response);

  assert.equal(new URL(redirect).origin, 'https://accounts.google.com');
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0]!.name, 'nexus_google_oauth_state');
  assert.equal(cookies[0]!.options.httpOnly, true);
  assert.equal(cookies[0]!.options.secure, context.config.cookieSecure);
  assert.equal(cookies[0]!.options.sameSite, 'lax');
  assert.equal(cookies[0]!.options.maxAge, 600_000);
  assert.ok(cookies[0]!.value.includes('.'));
});

test('Google exchange returns the standard auth payload and refresh/CSRF cookies', async () => {
  const context = setup();
  const payload = {
    user: {
      id: 'user-1', email: 'ada@example.com', name: 'Ada Lovelace', status: 'ACTIVE',
      emailVerifiedAt: new Date('2030-01-01T00:00:00Z'), createdAt: new Date('2030-01-01T00:00:00Z'),
    },
    accessToken: 'access-token-test',
    tokenType: 'Bearer' as const,
    expiresIn: 900,
    csrfToken: 'csrf-token-test',
    refreshToken: 'refresh-token-test',
    session: { id: 'session-1', expiresAt: new Date('2030-01-01T00:00:00Z') },
  };
  const googleOAuth = {
    ...context.service,
    exchange: async () => payload,
  } as GoogleOAuthService;
  const controller = createAuthController({
    config: context.config,
    service: {} as AuthService,
    googleOAuth,
  });
  const cookies: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
  let body: unknown;
  const response = {
    locals: {},
    cookie: (name: string, value: string, options: Record<string, unknown>) =>
      cookies.push({ name, value, options }),
    status() {
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  } as unknown as Response;
  const request = {
    validated: { body: { code: 'one-time-login-code' } },
    ip: '127.0.0.1',
    header: () => undefined,
  } as unknown as Request;
  await controller.googleExchange(request, response);

  assert.equal(cookies.length, 2);
  assert.equal(cookies[0]!.name, 'nexus_rt');
  assert.equal(cookies[0]!.value, 'refresh-token-test');
  assert.equal(cookies[0]!.options.httpOnly, true);
  assert.equal(cookies[1]!.name, 'nexus_csrf');
  assert.equal(cookies[1]!.options.httpOnly, false);
  assert.deepEqual(body, {
    success: true,
    data: {
      user: payload.user,
      accessToken: payload.accessToken,
      tokenType: payload.tokenType,
      expiresIn: payload.expiresIn,
      csrfToken: payload.csrfToken,
      session: payload.session,
    },
  });
});

test('Google callback rejects a missing, forged, or mismatched browser binding and audits failure', async () => {
  const context = setup();
  const { authorization, browserBinding } = await start(context);
  const state = authorization.searchParams.get('state')!;

  for (const binding of [undefined, 'forged', browserBinding.replace(state, 'other-state')]) {
    const redirect = new URL(await context.service.callback({ state, browserBinding: binding }));
    assert.equal(redirect.searchParams.get('error'), 'OAUTH_STATE_INVALID');
  }
  assert.equal(context.states[0]!.consumedAt, null);
  assert.equal(context.auditEvents.length, 3);
});

test('Google token endpoint errors redirect safely without exposing provider response details', async () => {
  const context = setup({}, { tokenError: new Error('secret provider response') });
  const { authorization, browserBinding } = await start(context);
  const redirect = new URL(
    await context.service.callback({
      code: 'google-code',
      state: authorization.searchParams.get('state')!,
      browserBinding,
    }),
  );
  assert.equal(redirect.origin, 'https://app.example.com');
  assert.equal(redirect.searchParams.get('error'), 'GOOGLE_TOKEN_INVALID');
  assert.equal(redirect.toString().includes('secret'), false);
  assert.equal(context.auditEvents.length, 1);
});

test('Google callback without a code redirects to the configured frontend with a stable error', async () => {
  const context = setup();
  const { authorization, browserBinding } = await start(context);
  const redirect = new URL(
    await context.service.callback({
      state: authorization.searchParams.get('state')!,
      browserBinding,
    }),
  );
  assert.equal(redirect.pathname, '/auth/google/callback');
  assert.equal(redirect.searchParams.get('error'), 'GOOGLE_CALLBACK_INVALID');
});

test('Google matching-email accounts fail generically instead of being linked or enumerated', async () => {
  const linkRequired = Object.assign(new Error('account exists'), {
    code: 'GOOGLE_ACCOUNT_LINK_REQUIRED',
  });
  const context = setup({}, { accountError: linkRequired });
  const { authorization, browserBinding } = await start(context);
  const redirect = new URL(
    await context.service.callback({
      code: 'google-code',
      state: authorization.searchParams.get('state')!,
      browserBinding,
    }),
  );
  assert.equal(redirect.searchParams.get('error'), 'GOOGLE_SIGN_IN_FAILED');
  assert.equal(redirect.searchParams.has('email'), false);
});
