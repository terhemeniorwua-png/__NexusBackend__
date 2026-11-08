import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getRedisClient } from '../../db/redis';
import { AppError } from '../../utils/errors';

// drive.file = only files the app creates or the user picks (no Google verification needed).
const DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file', 'openid', 'email'];
const STATE_TTL_MS = 10 * 60 * 1000;

export const driveAuthorizeQuerySchema = z.object({ workspaceId: z.string().uuid() });
export const driveCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(2000),
  error: z.string().max(200).optional(),
});

function driveConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new AppError(503, 'GOOGLE_DRIVE_NOT_CONFIGURED', 'The Google Drive integration is not configured');
  }
  return { clientId, clientSecret, redirectUri };
}

function stateKey(): Buffer {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new AppError(503, 'GOOGLE_DRIVE_NOT_CONFIGURED', 'The Google Drive integration is not configured');
  return createHash('sha256').update(`gdrive-oauth-state:${secret}`).digest();
}

function sign(body: string): string {
  return createHmac('sha256', stateKey()).update(body).digest('base64url');
}

export async function buildDriveAuthorizeUrl(input: { userId: string; workspaceId: string }): Promise<string> {
  const { clientId, redirectUri } = driveConfig();
  const nonce = randomBytes(16).toString('hex');
  await getRedisClient().set(`gdrive:oauth:state:${nonce}`, input.userId, { EX: STATE_TTL_MS / 1000 });
  const body = Buffer.from(
    JSON.stringify({ u: input.userId, w: input.workspaceId, n: nonce, e: Date.now() + STATE_TTL_MS }),
  ).toString('base64url');
  const state = `${body}.${sign(body)}`;

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DRIVE_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline'); // needed for a refresh token
  url.searchParams.set('prompt', 'consent'); // forces Google to return the refresh token
  url.searchParams.set('state', state);
  return url.toString();
}

export async function verifyDriveState(state: string): Promise<{ userId: string; workspaceId: string }> {
  const [body, sig, extra] = state.split('.');
  const bad = () => new AppError(400, 'GOOGLE_DRIVE_STATE_INVALID', 'The Google Drive authorization link is invalid or expired');
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
  const consumed = await getRedisClient().del(`gdrive:oauth:state:${claims.n}`);
  if (consumed !== 1) throw bad();
  return { userId: claims.u, workspaceId: claims.w };
}

export async function exchangeDriveCode(code: string) {
  const { clientId, clientSecret, redirectUri } = driveConfig();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as {
    access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new AppError(502, 'GOOGLE_DRIVE_OAUTH_FAILED', `Google rejected the authorization (${data.error ?? 'unknown'})`);
  }

  // Best effort: record which Google account was connected.
  let externalUserId: string | null = null;
  try {
    const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${data.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (info.ok) externalUserId = ((await info.json()) as { sub?: string }).sub ?? null;
  } catch {
    /* ignore */
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
    scopes: data.scope ? data.scope.split(' ') : [],
    externalUserId,
  };
}

export function driveResultUrl(status: 'connected' | 'denied' | 'error'): string {
  let origin = 'http://localhost:3000';
  try {
    if (process.env.FRONTEND_URL) origin = new URL(process.env.FRONTEND_URL).origin;
  } catch {
    /* keep default */
  }
  return `${origin}/app/integrations?integration=google_drive&status=${status}`;
}