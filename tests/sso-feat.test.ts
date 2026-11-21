process.env.JWT_ACCESS_SECRET ??= 'test-only-jwt-access-secret-not-for-production-use';

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { verifyOAuthState, createOAuthState } from '../src/modules/integrations/oauth-state';
import { validateSsoIdTokenClaims } from '../src/modules/sso/sso.service';

describe('SSO / OIDC Unit Tests', () => {
  test('OAuth state signature validation works', async () => {
    const { state } = await createOAuthState({
      provider: 'google',
      userId: 'user-1',
    });

    const claims = await verifyOAuthState('google', state);
    assert.strictEqual(claims.provider, 'google');
    assert.strictEqual(claims.userId, 'user-1');
  });

  test('OAuth state tampered signature is rejected', async () => {
    const { state } = await createOAuthState({
      provider: 'google',
      userId: 'user-1',
    });

    await assert.rejects(
      () => verifyOAuthState('google', `${state}tampered`),
      (err: Error) => err.message === 'The OAuth state is not valid',
    );
  });

  test('OAuth state expiry is detected', async () => {
    const { state } = await createOAuthState({
      provider: 'google',
      userId: 'user-1',
      ttlMs: 0,
    });

    await assert.rejects(
      () => verifyOAuthState('google', state),
      (err: Error) => err.message === 'The OAuth state has expired',
    );
  });

  test('OAuth state replay is rejected', async () => {
    const { state } = await createOAuthState({
      provider: 'google',
      userId: 'user-1',
    });
    await verifyOAuthState('google', state);
    await assert.rejects(
      () => verifyOAuthState('google', state),
      (err: Error) => err.message === 'The OAuth state has already been used',
    );
  });

  test('SSO token with wrong issuer is rejected', () => {
    const now = Date.now();
    assert.throws(
      () =>
        validateSsoIdTokenClaims(
          {
            iss: 'https://evil.example',
            aud: 'client-id',
            sub: 'sub-1',
            exp: Math.floor(now / 1000) + 300,
          },
          { issuer: 'https://trusted.example', audience: 'client-id', now },
        ),
      (err: { code?: string; statusCode?: number; message?: string }) => err?.code === 'SSO_INVALID_ISSUER',
    );
  });

  test('SSO token with wrong audience is rejected', () => {
    const now = Date.now();
    assert.throws(
      () =>
        validateSsoIdTokenClaims(
          {
            iss: 'https://trusted.example',
            aud: 'other-client',
            sub: 'sub-1',
            exp: Math.floor(now / 1000) + 300,
          },
          { issuer: 'https://trusted.example', audience: 'client-id', now },
        ),
      (err: { code?: string; statusCode?: number; message?: string }) => err?.code === 'SSO_INVALID_AUDIENCE',
    );
  });

  test('SSO token with expired exp is rejected', () => {
    const now = Date.now();
    assert.throws(
      () =>
        validateSsoIdTokenClaims(
          {
            iss: 'https://trusted.example',
            aud: 'client-id',
            sub: 'sub-1',
            exp: Math.floor(now / 1000) - 10,
          },
          { issuer: 'https://trusted.example', audience: 'client-id', now },
        ),
      (err: { code?: string; statusCode?: number; message?: string }) => err?.code === 'SSO_TOKEN_EXPIRED',
    );
  });

  test('SSO token with wrong nonce is rejected', () => {
    const now = Date.now();
    assert.throws(
      () =>
        validateSsoIdTokenClaims(
          {
            iss: 'https://trusted.example',
            aud: 'client-id',
            sub: 'sub-1',
            exp: Math.floor(now / 1000) + 300,
            nonce: 'bad',
          },
          { issuer: 'https://trusted.example', audience: 'client-id', nonce: 'good', now },
        ),
      (err: { code?: string; statusCode?: number; message?: string }) => err?.code === 'SSO_INVALID_NONCE',
    );
  });
});
