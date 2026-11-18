import { z } from 'zod';
import { AppError } from '../../utils/errors';
import { createOAuthState, verifyOAuthState } from './oauth-state';
import { integrationResultUrl } from './frontend-url';

const STATE_TTL_MS = 10 * 60 * 1000;
void STATE_TTL_MS;
const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'nexus-backend',
};

// Minimal scopes for linking PRs/issues to tasks and reading repo metadata.
const GITHUB_SCOPES = ['read:user', 'repo'];

export const githubAuthorizeQuerySchema = z.object({ workspaceId: z.string().uuid() });
export const githubCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(4000),
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

export async function buildGithubAuthorizeUrl(input: {
  userId: string;
  workspaceId: string;
}): Promise<string> {
  const { clientId, redirectUri } = githubConfig();
  const { state, codeChallenge } = await createOAuthState({
    provider: 'github',
    userId: input.userId,
    workspaceId: input.workspaceId,
    includePkce: true,
  });
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', GITHUB_SCOPES.join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'false');
  if (codeChallenge) {
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

export async function verifyGithubState(
  state: string,
): Promise<{ userId: string; workspaceId: string; codeVerifier?: string }> {
  const claims = await verifyOAuthState('github', state);
  if (!claims.workspaceId) {
    throw new AppError(400, 'OAUTH_STATE_INVALID', 'The OAuth state is not valid');
  }
  return { userId: claims.userId, workspaceId: claims.workspaceId, codeVerifier: claims.codeVerifier };
}

export async function exchangeGithubCode(input: {
  code: string;
  codeVerifier?: string;
}): Promise<{
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  scopes: string[];
  externalUserId: string | null;
  externalEmail: string | null;
}> {
  const { clientId, clientSecret, redirectUri } = githubConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: input.code,
    redirect_uri: redirectUri,
  });
  if (input.codeVerifier) params.set('code_verifier', input.codeVerifier);
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { ...GITHUB_HEADERS, Accept: 'application/json' },
    body: params,
  });
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
  } | null;
  if (!res.ok || !body?.access_token) {
    throw new AppError(502, 'GITHUB_OAUTH_FAILED', 'GitHub did not return an access token');
  }

  let externalUserId: string | null = null;
  let externalEmail: string | null = null;
  try {
    const me = await fetch('https://api.github.com/user', {
      headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${body.access_token}` },
    });
    if (me.ok) {
      const profile = (await me.json()) as { id?: number; login?: string; email?: string | null };
      externalUserId = profile.id != null ? String(profile.id) : (profile.login ?? null);
      externalEmail = profile.email ?? profile.login ?? null;
    }
  } catch {
    // identity is best-effort
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    tokenExpiresAt:
      typeof body.expires_in === 'number'
        ? new Date(Date.now() + body.expires_in * 1000).toISOString()
        : null,
    scopes: body.scope ? body.scope.split(/[, ]+/).filter(Boolean) : GITHUB_SCOPES,
    externalUserId,
    externalEmail,
  };
}

export async function refreshGithubToken(refreshToken: string): Promise<{
  accessToken: string;
  tokenExpiresAt: string | null;
  refreshToken?: string | null;
}> {
  const { clientId, clientSecret } = githubConfig();
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { ...GITHUB_HEADERS, Accept: 'application/json' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  } | null;
  if (!res.ok || !body?.access_token) {
    throw new AppError(502, 'GITHUB_REFRESH_FAILED', 'GitHub did not refresh the token');
  }
  return {
    accessToken: body.access_token,
    tokenExpiresAt:
      typeof body.expires_in === 'number'
        ? new Date(Date.now() + body.expires_in * 1000).toISOString()
        : null,
    refreshToken: body.refresh_token ?? null,
  };
}

export function githubResultUrl(status: 'connected' | 'denied' | 'error'): string {
  return integrationResultUrl('github', status);
}
