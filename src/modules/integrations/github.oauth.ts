import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getRedisClient } from '../../db/redis';
import { AppError } from '../../utils/errors';

const STATE_TTL_MS = 10 * 60 * 1000;
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'nexus-backend',
};

// workspaceId is accepted (the frontend sends it) but unused: GitHub is a personal connection.
export const githubAuthorizeQuerySchema = z.object({ workspaceId: z.string().uuid().optional() });
export const githubCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(2000),
  error: z.string().max(200).optional(),
});

function githubConfig() {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  const redirectUri = process.env.GITHUB_CALLBACK_URL;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new AppError(503, 'GITHUB_NOT_CONFIGURED', 'The GitHub integration is not configured');
  }
  return { clientId, clientSecret, redirectUri };
}

function stateKey(): Buffer {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new AppError(503, 'GITHUB_NOT_CONFIGURED', 'The GitHub integration is not configured');
  return createHash('sha256').update(`github-oauth-state:${secret}`).digest();
}

function sign(body: string): string {
  return createHmac('sha256', stateKey()).update(body).digest('base64url');
}

export async function buildGithubAuthorizeUrl(input: { userId: string }): Promise<string> {
  const { clientId, redirectUri } = githubConfig();
  const nonce = randomBytes(16).toString('hex');
  await getRedisClient().set(`github:oauth:state:${nonce}`, input.userId, { EX: STATE_TTL_MS / 1000 });
  const body = Buffer.from(JSON.stringify({ u: input.userId, n: nonce, e: Date.now() + STATE_TTL_MS })).toString('base64url');
  const state = `${body}.${sign(body)}`;

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export async function verifyGithubState(state: string): Promise<{ userId: string }> {
  const [body, sig, extra] = state.split('.');
  const bad = () => new AppError(400, 'GITHUB_STATE_INVALID', 'The GitHub authorization link is invalid or expired');
  if (!body || !sig || extra !== undefined) throw bad();
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw bad();
  let claims: { u?: unknown; e?: unknown; n?: unknown };
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof claims.u !== 'string' || typeof claims.e !== 'number' || claims.e < Date.now()) throw bad();
  if (typeof claims.n !== 'string' || !/^[0-9a-f]{32}$/.test(claims.n)) throw bad();
  // One-time use: a replayed state gets 0 from DEL and is rejected.
  const consumed = await getRedisClient().del(`github:oauth:state:${claims.n}`);
  if (consumed !== 1) throw bad();
  return { userId: claims.u };
}

interface GithubTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function postToken(params: Record<string, string>): Promise<GithubTokenResponse> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'nexus-backend' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10_000),
  });
  // GitHub returns HTTP 200 with an error field for most failures.
  const data = (await res.json().catch(() => ({}))) as GithubTokenResponse;
  if (!res.ok || data.error || !data.access_token) {
    throw new AppError(502, 'GITHUB_OAUTH_FAILED', `GitHub rejected the request (${data.error ?? res.status})`);
  }
  return data;
}

export async function exchangeGithubCode(code: string) {
  const { clientId, clientSecret, redirectUri } = githubConfig();
  const data = await postToken({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri });
  const auth = { ...GITHUB_HEADERS, Authorization: `Bearer ${data.access_token}` };

  let externalUserId: string | null = null;
  let externalEmail: string | null = null;
  try {
    const u = await fetch('https://api.github.com/user', { headers: auth, signal: AbortSignal.timeout(10_000) });
    if (u.ok) {
      const j = (await u.json()) as { id?: number; email?: string | null };
      externalUserId = j.id !== undefined ? String(j.id) : null;
      externalEmail = j.email ?? null;
    }
    if (!externalEmail) {
      const e = await fetch('https://api.github.com/user/emails', { headers: auth, signal: AbortSignal.timeout(10_000) });
      if (e.ok) {
        const list = (await e.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
        externalEmail = list.find((x) => x.primary && x.verified)?.email ?? null;
      }
    }
  } catch {
    /* best effort */
  }

  return {
    accessToken: data.access_token!,
    refreshToken: data.refresh_token ?? null,
    tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
    scopes: ['github-app'],
    externalUserId,
    externalEmail,
  };
}

/** GitHub App user tokens expire after 8 hours when "Expire user authorization tokens" is on. */
export async function refreshGithubToken(refreshToken: string) {
  const { clientId, clientSecret } = githubConfig();
  const data = await postToken({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  return {
    accessToken: data.access_token!,
    refreshToken: data.refresh_token ?? refreshToken,
    tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
  };
}

export function githubResultUrl(status: 'connected' | 'denied' | 'error'): string {
  let origin = 'http://localhost:3000';
  try {
    if (process.env.FRONTEND_URL) origin = new URL(process.env.FRONTEND_URL).origin;
  } catch {
    /* keep default */
  }
  return `${origin}/app/integrations?integration=github&status=${status}`;
}
