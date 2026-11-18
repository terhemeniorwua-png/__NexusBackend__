import type { JWTHeaderParameters } from 'jose';
import type { PrismaClient } from '@prisma/client';
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import crypto from 'node:crypto';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';

// These tests target the SSO OIDC implementation required for feat/sso-oidc.
// Some tests are pure/unit (token/state verification) and do not require DB.
// Integration/flow tests that require DB/app are marked/gated separately.

async function makeJwks() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-kid';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { publicKey, privateKey, jwks: { keys: [jwk] }, kid: jwk.kid as string };
}

async function signIdToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: 'RS256', kid: 'test-kid' },
) {
  let jwt = new SignJWT(claims).setProtectedHeader(header as unknown as JWTHeaderParameters);
  if (typeof claims.exp === 'number') jwt = jwt.setExpirationTime(claims.exp);
  if (typeof claims.iat === 'number') jwt = jwt.setIssuedAt(claims.iat);
  if (typeof claims.nbf === 'number') jwt = jwt.setNotBefore(claims.nbf);
  return jwt.sign(privateKey);
}

describe('SSO OIDC - ID token verification (mock IdP JWKS)', () => {
  test('accepts a valid ID token (signature, issuer, audience, expiry, nonce)', async () => {
    const { privateKey, jwks, kid } = await makeJwks();
    const now = Math.floor(Date.now() / 1000);
    const token = await signIdToken(privateKey, {
      iss: 'https://issuer.example',
      aud: 'client-123',
      sub: 'user-sub',
      email: 'user@verified.example',
      email_verified: true,
      nonce: 'nonce-1',
      exp: now + 300,
      iat: now,
    }, { alg: 'RS256', kid });

    const { verifySsoIdToken } = await import('../src/modules/sso/oidc.service');
    const claims = await verifySsoIdToken(token, {
      jwks,
      issuer: 'https://issuer.example',
      audience: 'client-123',
      nonce: 'nonce-1',
      clockSkewSec: 60,
    });
    assert.equal(claims.sub, 'user-sub');
    assert.equal(claims.email_verified, true);
  });

  test('rejects tampered token signature', async () => {
    const { privateKey, jwks, kid } = await makeJwks();
    const now = Math.floor(Date.now() / 1000);
    const token = await signIdToken(privateKey, {
      iss: 'https://issuer.example',
      aud: 'client-123',
      sub: 'user-sub',
      email: 'user@verified.example',
      email_verified: true,
      nonce: 'nonce-1',
      exp: now + 300,
      iat: now,
    }, { alg: 'RS256', kid });
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')), sub: 'attacker' })).toString('base64url');
    const tampered = parts.join('.');

    const { verifySsoIdToken } = await import('../src/modules/sso/oidc.service');
    await assert.rejects(
      () => verifySsoIdToken(tampered, {
        jwks,
        issuer: 'https://issuer.example',
        audience: 'client-123',
        nonce: 'nonce-1',
        clockSkewSec: 60,
      }),
    );
  });

  test('rejects wrong issuer', async () => {
    const { privateKey, jwks, kid } = await makeJwks();
    const now = Math.floor(Date.now() / 1000);
    const token = await signIdToken(privateKey, {
      iss: 'https://evil.example',
      aud: 'client-123',
      sub: 'user-sub',
      email_verified: true,
      nonce: 'nonce-1',
      exp: now + 300,
      iat: now,
    }, { alg: 'RS256', kid });

    const { verifySsoIdToken } = await import('../src/modules/sso/oidc.service');
    await assert.rejects(
      () => verifySsoIdToken(token, {
        jwks,
        issuer: 'https://issuer.example',
        audience: 'client-123',
        nonce: 'nonce-1',
        clockSkewSec: 60,
      }),
    );
  });

  test('rejects wrong audience', async () => {
    const { privateKey, jwks, kid } = await makeJwks();
    const now = Math.floor(Date.now() / 1000);
    const token = await signIdToken(privateKey, {
      iss: 'https://issuer.example',
      aud: 'wrong-client',
      sub: 'user-sub',
      email_verified: true,
      nonce: 'nonce-1',
      exp: now + 300,
      iat: now,
    }, { alg: 'RS256', kid });

    const { verifySsoIdToken } = await import('../src/modules/sso/oidc.service');
    await assert.rejects(
      () => verifySsoIdToken(token, {
        jwks,
        issuer: 'https://issuer.example',
        audience: 'client-123',
        nonce: 'nonce-1',
        clockSkewSec: 60,
      }),
    );
  });

  test('rejects expired token', async () => {
    const { privateKey, jwks, kid } = await makeJwks();
    const now = Math.floor(Date.now() / 1000);
    const token = await signIdToken(privateKey, {
      iss: 'https://issuer.example',
      aud: 'client-123',
      sub: 'user-sub',
      email_verified: true,
      nonce: 'nonce-1',
      exp: now - 120,
      iat: now - 300,
    }, { alg: 'RS256', kid });

    const { verifySsoIdToken } = await import('../src/modules/sso/oidc.service');
    await assert.rejects(
      () => verifySsoIdToken(token, {
        jwks,
        issuer: 'https://issuer.example',
        audience: 'client-123',
        nonce: 'nonce-1',
        clockSkewSec: 60,
      }),
    );
  });

  test('rejects wrong nonce', async () => {
    const { privateKey, jwks, kid } = await makeJwks();
    const now = Math.floor(Date.now() / 1000);
    const token = await signIdToken(privateKey, {
      iss: 'https://issuer.example',
      aud: 'client-123',
      sub: 'user-sub',
      email_verified: true,
      nonce: 'wrong-nonce',
      exp: now + 300,
      iat: now,
    }, { alg: 'RS256', kid });

    const { verifySsoIdToken } = await import('../src/modules/sso/oidc.service');
    await assert.rejects(
      () => verifySsoIdToken(token, {
        jwks,
        issuer: 'https://issuer.example',
        audience: 'client-123',
        nonce: 'expected-nonce',
        clockSkewSec: 60,
      }),
    );
  });
});

describe('SSO OIDC - DB-backed state/nonce (fail closed, single-use)', () => {
  test('replayed state is rejected (single-use)', async () => {
    const { consumeSsoOidcState } = await import('../src/modules/sso/oidc.service');
    const state = 'state-value';
    const browser = 'browser-cookie';
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');
    const browserHash = crypto.createHash('sha256').update(browser).digest('hex');
    let consumed = false;
    const db = {
      ssoOidcState: {
        findUnique: async () => ({
          id: 'st1',
          workspaceId: 'ws1',
          configId: 'cfg1',
          stateHash,
          nonce: 'nonce-1',
          codeVerifier: 'verifier',
          browserBindingHash: browserHash,
          redirectUri: null,
          expiresAt: new Date(Date.now() + 60000),
          consumedAt: consumed ? new Date() : null,
        }),
        updateMany: async ({ where }: { where: { consumedAt: Date | null } }) => {
          if (consumed || where.consumedAt !== null) return { count: 0 };
          consumed = true;
          return { count: 1 };
        },
      },
    } as unknown as PrismaClient;

    const first = await consumeSsoOidcState({ state, browserBindingValue: browser }, db);
    assert.equal(first.workspaceId, 'ws1');
    await assert.rejects(
      () => consumeSsoOidcState({ state, browserBindingValue: browser }, db),
      (err: { code?: string; statusCode?: number; message?: string }) => err?.code === 'SSO_STATE_REPLAYED' || err?.message?.includes('already been used'),
    );
  });

  test('fails closed when state store is unavailable', async () => {
    const { createSsoOidcState, consumeSsoOidcState } = await import('../src/modules/sso/oidc.service');
    const brokenDb = {
      ssoOidcState: {
        create: async () => { throw new Error('db down'); },
        findUnique: async () => { throw new Error('db down'); },
        updateMany: async () => { throw new Error('db down'); },
      },
    } as unknown as PrismaClient;

    await assert.rejects(
      () => createSsoOidcState({ workspaceId: 'ws1', browserBindingValue: 'b' }, brokenDb),
      (err: { code?: string; statusCode?: number; message?: string }) => err?.code === 'SSO_STATE_STORE_UNAVAILABLE',
    );
    await assert.rejects(
      () => consumeSsoOidcState({ state: 's', browserBindingValue: 'b' }, brokenDb),
      (err: { code?: string; statusCode?: number; message?: string }) => err?.code === 'SSO_STATE_STORE_UNAVAILABLE',
    );
  });

  test('rejects cross-workspace state use (workspace binding)', async () => {
    const { consumeSsoOidcState } = await import('../src/modules/sso/oidc.service');
    const state = 'state-value';
    const browser = 'browser-cookie';
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');
    const browserHash = crypto.createHash('sha256').update(browser).digest('hex');
    const db = {
      ssoOidcState: {
        findUnique: async () => ({
          id: 'st1',
          workspaceId: 'ws1',
          configId: 'cfg1',
          stateHash,
          nonce: 'nonce-1',
          codeVerifier: 'verifier',
          browserBindingHash: browserHash,
          redirectUri: null,
          expiresAt: new Date(Date.now() + 60000),
          consumedAt: null,
        }),
        updateMany: async () => ({ count: 1 }),
      },
    } as unknown as PrismaClient;

    await assert.rejects(
      () => consumeSsoOidcState({ state, browserBindingValue: browser, workspaceId: 'ws2' }, db),
      (err: { code?: string; statusCode?: number; message?: string }) => err?.code === 'SSO_STATE_INVALID',
    );
  });
});

describe('SSO OIDC - policy checks (pure)', () => {
  test('rejects unverified email from IdP (email_verified false)', async () => {
    const { assertVerifiedIdpEmail } = await import('../src/modules/sso/oidc.service');
    assert.throws(() => assertVerifiedIdpEmail({ email: 'user@example.com', email_verified: false }));
  });

  test('rejects missing email_verified claim', async () => {
    const { assertVerifiedIdpEmail } = await import('../src/modules/sso/oidc.service');
    assert.throws(() => assertVerifiedIdpEmail({ email: 'user@example.com' }));
  });

  test('rejects domain not verified for workspace', async () => {
    const { isEmailDomainAllowed } = await import('../src/modules/sso/oidc.service');
    assert.equal(isEmailDomainAllowed('user@unverified.com', ['verified.com']), false);
  });

  test('cross-workspace isolation: domain verified in other workspace does not grant access', async () => {
    const { isEmailDomainAllowed } = await import('../src/modules/sso/oidc.service');
    // Simulates workspace A verified domains only
    assert.equal(isEmailDomainAllowed('user@workspace-b.com', ['workspace-a.com']), false);
  });

  test('account takeover via email change: must not link by unverified changed email', async () => {
    const { canLinkSsoIdentity } = await import('../src/modules/sso/oidc.service');
    assert.equal(canLinkSsoIdentity({ idpEmailVerified: false, domainVerified: true, existingAccountEmailVerified: true }), false);
  });
});

describe('SSO enforcement - require SSO blocks password login paths', () => {
  test('userHasRequiredSsoWorkspace returns required when active membership is in SSO-required workspace', async () => {
    const { userHasRequiredSsoWorkspace } = await import('../src/modules/sso/sso.service');
    const db = {
      workspaceMembership: {
        findMany: async () => [{ workspaceId: 'ws1' }],
      },
      workspaceSsoConfig: {
        findFirst: async () => ({ id: 'cfg1', isEnabled: true, requireSso: true, breakGlassEnabled: true }),
      },
      workspaceSsoDomain: {
        count: async () => 1,
      },
    } as never;
    const result = await userHasRequiredSsoWorkspace(db, 'user1');
    assert.equal(result.required, true);
    assert.equal(result.workspaceId, 'ws1');
  });

  test('assertUserPasswordLoginAllowed throws SSO_REQUIRED when workspace requires SSO', async () => {
    const { assertUserPasswordLoginAllowed } = await import('../src/modules/sso/sso.service');
    const db = {
      workspaceMembership: {
        findMany: async () => [{ workspaceId: 'ws1' }],
      },
      workspaceSsoConfig: {
        findFirst: async () => ({ id: 'cfg1', isEnabled: true, requireSso: true, breakGlassEnabled: false }),
      },
      workspaceSsoDomain: {
        count: async () => 1,
      },
    } as never;
    await assert.rejects(
      () => assertUserPasswordLoginAllowed(db, 'user1'),
      (err: unknown) => (err as { code?: string })?.code === 'SSO_REQUIRED',
    );
  });

  test('assertUserPasswordLoginAllowed allows when no workspace requires SSO', async () => {
    const { assertUserPasswordLoginAllowed } = await import('../src/modules/sso/sso.service');
    const db = {
      workspaceMembership: {
        findMany: async () => [{ workspaceId: 'ws1' }],
      },
      workspaceSsoConfig: {
        findFirst: async () => null,
      },
    } as never;
    await assert.doesNotReject(() => assertUserPasswordLoginAllowed(db, 'user1'));
  });
});

describe('SSO enforcement - config removal revokes sessions', () => {
  test('disableSsoConfig revokes active sessions when require-SSO was enabled', async () => {
    const { disableSsoConfig } = await import('../src/modules/sso/sso.service');
    let revokedCalls = 0;
    const db = {
      workspace: { findFirst: async () => ({ id: 'ws1', status: 'ACTIVE', type: 'COMPANY', deletedAt: null }) },
      workspaceMembership: {
        findUnique: async () => ({ id: 'm1', workspaceId: 'ws1', userId: 'admin1', role: 'OWNER', organizationRole: null, status: 'ACTIVE' }),
        findFirst: async () => ({ role: 'OWNER', organizationRole: null, status: 'ACTIVE' }),
        findMany: async () => [{ userId: 'u1' }, { userId: 'u2' }],
      },
      workspaceSsoConfig: {
        findFirst: async () => ({ id: 'cfg1', workspaceId: 'ws1', isEnabled: true, requireSso: true }),
        update: async () => ({ id: 'cfg1', isEnabled: false, requireSso: false, status: 'DISABLED' }),
      },
      session: {
        updateMany: async () => { revokedCalls++; return { count: 1 }; },
      },
      auditLog: { create: async () => ({}) },
    } as never;
    const result = await disableSsoConfig(db, 'admin1', 'ws1', 'cfg1');
    assert.equal(result.disabled, true);
    assert.equal(result.revokedSessions, 2);
    assert.equal(revokedCalls, 2);
  });
});
