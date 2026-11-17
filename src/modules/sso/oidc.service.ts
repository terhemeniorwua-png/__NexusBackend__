import crypto from 'node:crypto';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import { encryptIntegrationToken, decryptIntegrationToken } from '../integrations/token-crypto';
import type { AppConfig } from '../../config/env';
import type { AuthService } from '../auth/auth.service';

export const SSO_BROWSER_BINDING_COOKIE = 'nexus_sso_oidc_binding';
const DEFAULT_CLOCK_SKEW_SEC = 60;

export interface VerifySsoIdTokenOptions {
  jwks: JSONWebKeySet;
  issuer: string;
  audience: string;
  nonce: string;
  clockSkewSec?: number;
}

export interface SsoIdpClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  email?: string;
  email_verified?: boolean;
  nonce?: string;
  exp?: number;
  iat?: number;
  name?: string;
  [key: string]: unknown;
}

export async function verifySsoIdToken(
  idToken: string,
  options: VerifySsoIdTokenOptions,
): Promise<SsoIdpClaims> {
  const jwks = createLocalJWKSet(options.jwks);
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: options.issuer,
    audience: options.audience,
    clockTolerance: options.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC,
  });

  const claims = payload as SsoIdpClaims;
  if (!claims.nonce || claims.nonce !== options.nonce) {
    throw new AppError(401, 'SSO_INVALID_NONCE', 'SSO ID token nonce is invalid');
  }
  return claims;
}

export function assertVerifiedIdpEmail(claims: { email?: string; email_verified?: boolean }): string {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (!email) {
    throw new AppError(401, 'SSO_EMAIL_MISSING', 'SSO identity provider did not return an email address');
  }
  if (claims.email_verified !== true) {
    throw new AppError(401, 'SSO_EMAIL_UNVERIFIED', 'SSO identity provider email is not verified');
  }
  return email;
}

export function isEmailDomainAllowed(email: string, verifiedDomains: string[]): boolean {
  const domain = email.split('@')[1]?.trim().toLowerCase();
  if (!domain) return false;
  const allowed = verifiedDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(domain);
}

export function canLinkSsoIdentity(input: {
  idpEmailVerified: boolean;
  domainVerified: boolean;
  existingAccountEmailVerified: boolean;
}): boolean {
  return Boolean(input.idpEmailVerified && input.domainVerified && input.existingAccountEmailVerified);
}

export function encryptClientSecret(plain: string): string {
  return encryptIntegrationToken(plain);
}

export function decryptClientSecret(ciphertext: string): string {
  return decryptIntegrationToken(ciphertext);
}

function hashValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export interface CreateSsoOidcStateInput {
  workspaceId: string;
  configId?: string | null;
  browserBindingValue: string;
  redirectUri?: string | null;
  ttlMs?: number;
}

export interface CreatedSsoOidcState {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: Date;
}

export async function createSsoOidcState(
  input: CreateSsoOidcStateInput,
  db = getPrismaClient(),
): Promise<CreatedSsoOidcState> {
  const state = crypto.randomBytes(32).toString('base64url');
  const nonce = crypto.randomBytes(24).toString('base64url');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const ttlMs = input.ttlMs ?? 10 * 60 * 1000;
  const expiresAt = new Date(Date.now() + ttlMs);

  try {
    await db.ssoOidcState.create({
      data: {
        workspaceId: input.workspaceId,
        configId: input.configId ?? null,
        stateHash: hashValue(state),
        nonce,
        codeVerifier,
        browserBindingHash: hashValue(input.browserBindingValue),
        redirectUri: input.redirectUri ?? null,
        expiresAt,
      },
    });
  } catch {
    throw new AppError(503, 'SSO_STATE_STORE_UNAVAILABLE', 'SSO state store is unavailable');
  }

  return { state, nonce, codeVerifier, expiresAt };
}

export async function consumeSsoOidcState(
  input: { state: string; browserBindingValue: string; workspaceId?: string },
  db = getPrismaClient(),
): Promise<{ workspaceId: string; configId: string | null; nonce: string; codeVerifier: string; redirectUri: string | null }> {
  const stateHash = hashValue(input.state);
  const browserBindingHash = hashValue(input.browserBindingValue);

  try {
    const record = await db.ssoOidcState.findUnique({ where: { stateHash } });
    if (!record) {
      throw new AppError(400, 'SSO_STATE_INVALID', 'SSO state is invalid or expired');
    }
    if (record.consumedAt) {
      throw new AppError(400, 'SSO_STATE_REPLAYED', 'SSO state has already been used');
    }
    if (record.expiresAt.getTime() <= Date.now()) {
      throw new AppError(400, 'SSO_STATE_EXPIRED', 'SSO state has expired');
    }
    if (record.browserBindingHash !== browserBindingHash) {
      throw new AppError(400, 'SSO_STATE_INVALID', 'SSO state browser binding mismatch');
    }
    if (input.workspaceId && record.workspaceId !== input.workspaceId) {
      throw new AppError(400, 'SSO_STATE_INVALID', 'SSO state workspace mismatch');
    }

    const updated = await db.ssoOidcState.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (updated.count !== 1) {
      throw new AppError(400, 'SSO_STATE_REPLAYED', 'SSO state has already been used');
    }

    return {
      workspaceId: record.workspaceId,
      configId: record.configId,
      nonce: record.nonce,
      codeVerifier: record.codeVerifier,
      redirectUri: record.redirectUri,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(503, 'SSO_STATE_STORE_UNAVAILABLE', 'SSO state store is unavailable');
  }
}

export function createPkceChallenge(codeVerifier: string): { codeChallenge: string; codeChallengeMethod: 'S256' } {
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeChallenge, codeChallengeMethod: 'S256' };
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export async function discoverOidcIssuer(issuer: string, fetchFn: typeof fetch = fetch): Promise<OidcDiscovery> {
  const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
  const res = await fetchFn(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new AppError(502, 'SSO_IDP_DISCOVERY_FAILED', 'Failed to discover OIDC issuer configuration');
  }
  const doc = (await res.json()) as Partial<OidcDiscovery>;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || !doc.issuer) {
    throw new AppError(502, 'SSO_IDP_DISCOVERY_FAILED', 'OIDC issuer configuration is incomplete');
  }
  return doc as OidcDiscovery;
}

export async function fetchJwks(jwksUri: string, fetchFn: typeof fetch = fetch): Promise<JSONWebKeySet> {
  const res = await fetchFn(jwksUri, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new AppError(502, 'SSO_IDP_JWKS_FAILED', 'Failed to fetch OIDC provider JWKS');
  }
  return (await res.json()) as JSONWebKeySet;
}

export async function exchangeAuthorizationCode(input: {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string | null;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetchFn?: typeof fetch;
}): Promise<{ id_token: string; access_token?: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
  });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (input.clientSecret) {
    // basic auth preferred but some providers accept in body; basic auth is fine
    const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64');
    headers.authorization = `Basic ${basic}`;
  }
  const res = await (input.fetchFn ?? fetch)(input.tokenEndpoint, { method: 'POST', headers, body });
  if (!res.ok) {
    throw new AppError(401, 'SSO_CODE_EXCHANGE_FAILED', 'Failed to exchange authorization code');
  }
  const json = (await res.json()) as { id_token?: string; access_token?: string };
  if (!json.id_token) {
    throw new AppError(401, 'SSO_ID_TOKEN_MISSING', 'Identity provider did not return an ID token');
  }
  return { id_token: json.id_token, access_token: json.access_token };
}

export async function verifyIdTokenWithRemoteJwks(input: {
  idToken: string;
  jwksUri: string;
  issuer: string;
  audience: string;
  nonce: string;
  clockSkewSec?: number;
  fetchFn?: typeof fetch;
}): Promise<SsoIdpClaims> {
  const jwks = await fetchJwks(input.jwksUri, input.fetchFn);
  return verifySsoIdToken(input.idToken, {
    jwks,
    issuer: input.issuer,
    audience: input.audience,
    nonce: input.nonce,
    clockSkewSec: input.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC,
  });
}

export async function getVerifiedDomainsForWorkspace(workspaceId: string, db = getPrismaClient()): Promise<string[]> {
  const domains = await db.workspaceSsoDomain.findMany({
    where: { workspaceId, verifiedAt: { not: null } },
    select: { domain: true },
  });
  return domains.map((d) => d.domain.toLowerCase());
}

export async function resolveSsoUser(input: {
  workspaceId: string;
  email: string;
  emailVerifiedByIdp: boolean;
  jitEnabled: boolean;
  domainVerified: boolean;
  sub: string;
  provider: string;
  name?: string | null;
}, db = getPrismaClient()): Promise<{ userId: string; created: boolean }> {
  // Only link to existing account by VERIFIED email from IdP and verified workspace domain.
  if (!input.emailVerifiedByIdp) {
    throw new AppError(401, 'SSO_EMAIL_UNVERIFIED', 'SSO identity provider email is not verified');
  }
  if (!input.domainVerified) {
    throw new AppError(403, 'SSO_DOMAIN_NOT_VERIFIED', 'Email domain is not verified for this workspace');
  }

  const normalizedEmail = input.email.trim().toLowerCase();

  // Check external identity link first (same provider+subject in this workspace context is handled by provider scoping;
  // we use provider name + sub for uniqueness across providers)
  const providerKey = `${input.provider}:${input.workspaceId}`;
  const existingIdentity = await db.externalIdentity.findUnique({
    where: { provider_providerSubjectId: { provider: providerKey, providerSubjectId: input.sub } },
    select: { userId: true },
  });

  if (existingIdentity) {
    // Ensure linked account still has verified email and belongs/is allowed; do not allow takeover via changed email.
    const user = await db.user.findUnique({ where: { id: existingIdentity.userId }, select: { id: true, email: true, emailVerifiedAt: true, deletedAt: true } });
    if (!user || user.deletedAt) {
      throw new AppError(401, 'SSO_IDENTITY_INVALID', 'Linked account is not available');
    }
    // If account email changed to something different/unverified in risky way, require verified match for safety.
    if (user.email.toLowerCase() !== normalizedEmail) {
      // account takeover via email change protection: require both verified and matching/explicit re-link policy.
      // Do not auto-link/rebind; require manual resolution.
      throw new AppError(403, 'SSO_EMAIL_CHANGE_CONFLICT', 'SSO email does not match the linked account');
    }
    if (!user.emailVerifiedAt) {
      throw new AppError(403, 'SSO_ACCOUNT_EMAIL_UNVERIFIED', 'Linked account email is not verified');
    }
    return { userId: user.id, created: false };
  }

  // Try to find existing account by verified email only
  const existingUser = await db.user.findUnique({
    where: { email: normalizedEmail },
    select: { id: true, emailVerifiedAt: true, deletedAt: true },
  });

  if (existingUser) {
    if (existingUser.deletedAt) {
      throw new AppError(403, 'SSO_ACCOUNT_UNAVAILABLE', 'Account is not available');
    }
    if (!existingUser.emailVerifiedAt) {
      // Never auto-link an unverified email
      throw new AppError(403, 'SSO_ACCOUNT_EMAIL_UNVERIFIED', 'Existing account email is not verified');
    }
    // Link identity to verified existing account
    await db.externalIdentity.create({
      data: {
        userId: existingUser.id,
        provider: providerKey,
        providerSubjectId: input.sub,
      },
    });
    return { userId: existingUser.id, created: false };
  }

  // JIT creation only if workspace enables it
  if (!input.jitEnabled) {
    throw new AppError(403, 'SSO_JIT_DISABLED', 'Just-in-time provisioning is not enabled for this workspace');
  }

  // Create new user (SSO-provisioned). Password is random/unusable; user authenticates via SSO.
  const randomPasswordHash = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
  const created = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: normalizedEmail,
        name: input.name?.trim() || normalizedEmail.split('@')[0] || 'SSO User',
        passwordHash: randomPasswordHash,
        status: 'ACTIVE',
        emailVerifiedAt: new Date(), // verified by IdP
      },
      select: { id: true },
    });
    await tx.externalIdentity.create({
      data: {
        userId: user.id,
        provider: providerKey,
        providerSubjectId: input.sub,
      },
    });
    // Ensure workspace membership if needed? JIT provisioning into workspace context -
    // at minimum we create identity; membership provisioning depends on product rules.
    // Create active membership for workspace if not personal-only context.
    await tx.workspaceMembership.upsert({
      where: { workspaceId_userId: { workspaceId: input.workspaceId, userId: user.id } },
      update: { status: 'ACTIVE' },
      create: {
        workspaceId: input.workspaceId,
        userId: user.id,
        role: 'MEMBER',
        status: 'ACTIVE',
      },
    }).catch(() => undefined);
    return user;
  });

  return { userId: created.id, created: true };
}
