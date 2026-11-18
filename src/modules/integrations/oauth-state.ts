import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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

// In-memory replay/consumption cache (best-effort, per-process fallback).
// In production this should be backed by Redis/DB for multi-instance safety.
const consumedStates = new Map<string, number>();

function cleanupConsumed(now = Date.now()): void {
  for (const [key, exp] of consumedStates.entries()) {
    if (exp <= now) consumedStates.delete(key);
  }
}

function sign(body: string): string {
  const secret = process.env.JWT_ACCESS_SECRET || 'test-secret';
  return createHmac('sha256', createHash('sha256').update(secret).digest()).update(body).digest('base64url');
}

export function toBase64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function createPkce(): { verifier: string; challenge: string; method: 'S256' } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' };
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
  const body = JSON.stringify(claims);
  const state = `${body}.${sign(body)}`;
  return { state, codeVerifier: pkce?.verifier, codeChallenge: pkce?.challenge };
}

export async function verifyOAuthState(
  provider: string,
  state: string,
): Promise<OAuthStateClaims> {
  cleanupConsumed();
  const [body, sig] = state.split('.');
  if (!body || !sig) {
    throw new Error('The OAuth state is not valid');
  }
  const expected = sign(body);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('The OAuth state is not valid');
  }
  let claims: OAuthStateClaims;
  try {
    claims = JSON.parse(body) as OAuthStateClaims;
  } catch {
    throw new Error('The OAuth state is not valid');
  }
  if (
    claims.provider !== provider ||
    typeof claims.userId !== 'string' ||
    typeof claims.nonce !== 'string' ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number'
  ) {
    throw new Error('The OAuth state is not valid');
  }
  if (claims.exp <= Date.now()) {
    throw new AppError(400, 'OAUTH_STATE_EXPIRED', 'The OAuth state has expired');
  }
  if (claims.iat > Date.now() + 30_000) {
    throw new AppError(400, 'OAUTH_STATE_INVALID', 'The OAuth state has invalid issued-at');
  }

  const replayKey = `${provider}:${claims.nonce}:${sha256Base64Url(state)}`;
  if (consumedStates.has(replayKey)) {
    throw new AppError(400, 'OAUTH_STATE_INVALID', 'The OAuth state has already been used');
  }
  consumedStates.set(replayKey, claims.exp);

  return claims;
}
