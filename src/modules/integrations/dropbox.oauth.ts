import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getRedisClient } from '../../db/redis';
import { AppError } from '../../utils/errors';

// Must match what is enabled on the Permissions tab of the Dropbox app.
const DROPBOX_SCOPES = [
  'account_info.read',
  'files.metadata.read',
  'files.content.read',
  'files.content.write',
  'sharing.read',
  'sharing.write',
];
const STATE_TTL_MS = 10 * 60 * 1000;

export const dropboxAuthorizeQuerySchema = z.object({ workspaceId: z.string().uuid() });
export const dropboxCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(2000),
  error: z.string().max(200).optional(),
});

function dropboxConfig() {
  const clientId = process.env.DROPBOX_APP_KEY;
  const clientSecret = process.env.DROPBOX_APP_SECRET;
  const redirectUri = process.env.DROPBOX_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new AppError(503, 'DROPBOX_NOT_CONFIGURED', 'The Dropbox integration is not configured');
  }
  return { clientId, clientSecret, redirectUri };
}

function stateKey(): Buffer {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new AppError(503, 'DROPBOX_NOT_CONFIGURED', 'The Dropbox integration is not configured');
  return createHash('sha256').update(`dropbox-oauth-state:${secret}`).digest();
}

function sign(body: string): string {
  return createHmac('sha256', stateKey()).update(body).digest('base64url');
}

export async function buildDropboxAuthorizeUrl(input: { userId: string; workspaceId: string }): Promise<string> {
  const { clientId, redirectUri } = dropboxConfig();
  const nonce = randomBytes(16).toString('hex');
  await getRedisClient().set(`dropbox:oauth:state:${nonce}`, input.userId, { EX: STATE_TTL_MS / 1000 });
  const body = Buffer.from(
    JSON.stringify({ u: input.userId, w: input.workspaceId, n: nonce, e: Date.now() + STATE_TTL_MS }),
  ).toString('base64url');
  const state = `${body}.${sign(body)}`;

  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('token_access_type', 'offline'); // needed for a refresh token
  url.searchParams.set('scope', DROPBOX_SCOPES.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

export async function verifyDropboxState(state: string): Promise<{ userId: string; workspaceId: string }> {
  const [body, sig, extra] = state.split('.');
  const bad = () => new AppError(400, 'DROPBOX_STATE_INVALID', 'The Dropbox authorization link is invalid or expired');
  if (!body || !sig || extra !== undefined) throw bad();
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw bad();
  let claims: { u?: unknown; w?: unknown; e?: unknown; n?: unknown };
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof claims.u !== 'string' || typeof claims.w !== 'string' || typeof claims.e !== 'number' || claims.e < Date.now()) {
    throw bad();
  }
  if (typeof claims.n !== 'string' || !/^[0-9a-f]{32}$/.test(claims.n)) throw bad();
  // One-time use: a replayed state gets 0 from DEL and is rejected.
  const consumed = await getRedisClient().del(`dropbox:oauth:state:${claims.n}`);
  if (consumed !== 1) throw bad();
  return { userId: claims.u, workspaceId: claims.w };
}

interface DropboxTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  account_id?: string;
  error?: string;
  error_description?: string;
}

async function postToken(params: Record<string, string>): Promise<DropboxTokenResponse> {
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as DropboxTokenResponse;
  if (!res.ok || !data.access_token) {
    throw new AppError(502, 'DROPBOX_OAUTH_FAILED', `Dropbox rejected the request (${data.error ?? res.status})`);
  }
  return data;
}

export async function exchangeDropboxCode(code: string) {
  const { clientId, clientSecret, redirectUri } = dropboxConfig();
  const data = await postToken({
    code,
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });
  return {
    accessToken: data.access_token!,
    refreshToken: data.refresh_token ?? null,
    tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
    scopes: data.scope ? data.scope.split(' ') : [],
    externalUserId: data.account_id ?? null,
  };
}

/** Dropbox access tokens last about 4 hours. Call this with the stored refresh token before using Dropbox. */
export async function refreshDropboxToken(refreshToken: string) {
  const { clientId, clientSecret } = dropboxConfig();
  const data = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  return {
    accessToken: data.access_token!,
    tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
  };
}

export function dropboxResultUrl(status: 'connected' | 'denied' | 'error'): string {
  let origin = 'http://localhost:3000';
  try {
    if (process.env.FRONTEND_URL) origin = new URL(process.env.FRONTEND_URL).origin;
  } catch {
    /* keep default */
  }
  return `${origin}/app?integration=dropbox&status=${status}`;
}