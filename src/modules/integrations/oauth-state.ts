import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getRedisClient } from '../../db/redis';
import { AppError } from '../../utils/errors';

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthStateClaims {
  userId: string;
  workspaceId: string | null;
  nonce: string;
  provider: string;
  codeVerifier?: string;
  iat: number;
  exp: number;
}

function stateKey(): Buffer {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new AppError(503, 'INTEGRATIONS_NOT_CONFIGURED', 'OAuth state signing is not configured');
  }
  return createHash('sha256').update(secret).digest();
}

function sign(body: string): string {
  return createHmac('sha256', stateKey()).update(body).digest('base64url');
}

export function toBase64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function createPkce(): { verifier: string; challenge: string; method: 'S256' } {
  const verifier = toBase64Url(randomBytes(32));
  return { verifier, challenge: sha256Base64Url(verifier), method: 'S256' };
}

export async function createOAuthState(input: {
  provider: string;
  userId: string;
  workspaceId?: string | null;
  includePkce?: boolean;
  ttlMs?: number;
}): Promise<{ state: string; codeVerifier?: string; codeChallenge?: string }> {
  const nonce = randomBytes(16).toString('hex');
  const now = Date.now();
  const ttlMs = input.ttlMs ?? OAUTH_STATE_TTL_MS;
  const pkce = input.includePkce ? createPkce() : null;
  const claims: OAuthStateClaims = {
    userId: input.userId,
    workspaceId: input.workspaceId ?? null,
    nonce,
    provider: input.provider,
    codeVerifier: pkce?.verifier,
    iat: now,
    exp: now + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const state = `${body}.${sign(body)}`;
  try {
    const redis = getRedisClient();
    if (redis) {
      await (redis as unknown as { set: (...args: unknown[]) => Promise<unknown> }).set(
        `oauth:state:${input.provider}:${nonce}`,
        '1',
        'PX',
        ttlMs,
      );
    }
  } catch {
    // Redis is optional for state issuance; signed+expiring state still provides CSRF protection.
  }
  return { state, codeVerifier: pkce?.verifier, codeChallenge: pkce?.challenge };
}

export async function verifyOAuthState(
  provider: string,
  state: string,
): Promise<OAuthStateClaims> {
  const [body, sig] = state.split('.');
  if (!body || !sig) {
    throw new AppError(400, 'OAUTH_STATE_INVALID', 'The OAuth state is not valid');
  }
  const expected = sign(body);
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError(400, 'OAUTH_STATE_INVALID', 'The OAuth state is not valid');
  }
  let claims: OAuthStateClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStateClaims;
  } catch {
    throw new AppError(400, 'OAUTH_STATE_INVALID', 'The OAuth state is not valid');
  }
  if (
    claims.provider !== provider ||
    typeof claims.userId !== 'string' ||
    typeof claims.nonce !== 'string' ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number'
  ) {
    throw new AppError(400, 'OAUTH_STATE_INVALID', 'The OAuth state is not valid');
  }
  if (claims.exp < Date.now() || claims.iat > Date.now() + 30_000) {
    throw new AppError(400, 'OAUTH_STATE_EXPIRED', 'The OAuth state has expired');
  }
  try {
    const redis = getRedisClient();
    if (redis) {
      const key = `oauth:state:${provider}:${claims.nonce}`;
      const exists = await redis.get(key);
      if (!exists) {
        throw new AppError(400, 'OAUTH_STATE_EXPIRED', 'The OAuth state has expired');
      }
      await redis.del(key);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    // If Redis is unavailable, fall back to signed+expiring state validation.
  }
  return claims;
}

export function safeRedirectResult(frontendUrl: string, path: string, status: string): string {
  const base = frontendUrl.replace(/\/$/, '');
  return `${base}${path}?integration=${encodeURIComponent(status)}`;
}
