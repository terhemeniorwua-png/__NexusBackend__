import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getRedisClient } from '../../db/redis';
import { AppError } from '../../utils/errors';

const GMAIL_API_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.modify',
];
// Must all be listed under Data Access in the Google Auth Platform console.
const GMAIL_SCOPES = [...GMAIL_API_SCOPES, 'openid', 'email'];
const STATE_TTL_MS = 10 * 60 * 1000;

// workspaceId is accepted (the frontend sends it) but unused: Gmail is a personal connection.
export const gmailAuthorizeQuerySchema = z.object({ workspaceId: z.string().uuid().optional() });
export const gmailCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(2000),
  error: z.string().max(200).optional(),
});

function gmailConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new AppError(503, 'GMAIL_NOT_CONFIGURED', 'The Gmail integration is not configured');
  }
  return { clientId, clientSecret, redirectUri };
}

function stateKey(): Buffer {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new AppError(503, 'GMAIL_NOT_CONFIGURED', 'The Gmail integration is not configured');
  return createHash('sha256').update(`gmail-oauth-state:${secret}`).digest();
}

function sign(body: string): string {
  return createHmac('sha256', stateKey()).update(body).digest('base64url');
}

export async function buildGmailAuthorizeUrl(input: { userId: string }): Promise<string> {
  const { clientId, redirectUri } = gmailConfig();
  const nonce = randomBytes(16).toString('hex');
  await getRedisClient().set(`gmail:oauth:state:${nonce}`, input.userId, { EX: STATE_TTL_MS / 1000 });
  const body = Buffer.from(JSON.stringify({ u: input.userId, n: nonce, e: Date.now() + STATE_TTL_MS })).toString('base64url');
  const state = `${body}.${sign(body)}`;

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_SCOPES.join(' '));
  url.searchParams.set('access_type', 'offline'); // refresh token
  url.searchParams.set('prompt', 'consent'); // forces Google to return the refresh token
  url.searchParams.set('state', state);
  return url.toString();
}

export async function verifyGmailState(state: string): Promise<{ userId: string }> {
  const [body, sig, extra] = state.split('.');
  const bad = () => new AppError(400, 'GMAIL_STATE_INVALID', 'The Gmail authorization link is invalid or expired');
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
  const consumed = await getRedisClient().del(`gmail:oauth:state:${claims.n}`);
  if (consumed !== 1) throw bad();
  return { userId: claims.u };
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

async function postToken(params: Record<string, string>): Promise<GoogleTokenResponse> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as GoogleTokenResponse;
  if (!res.ok || !data.access_token) {
    throw new AppError(502, 'GMAIL_OAUTH_FAILED', `Google rejected the request (${data.error ?? res.status})`);
  }
  return data;
}

export async function exchangeGmailCode(code: string) {
  const { clientId, clientSecret, redirectUri } = gmailConfig();
  const data = await postToken({
    code,
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  // Users can untick individual permissions on Google's consent screen.
  const granted = (data.scope ?? '').split(' ');
  const missing = GMAIL_API_SCOPES.filter((s) => !granted.includes(s));
  if (missing.length > 0) {
    throw new AppError(400, 'GMAIL_SCOPES_MISSING', 'All requested Gmail permissions must be granted');
  }

  let externalUserId: string | null = null;
  let externalEmail: string | null = null;
  try {
    const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${data.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (info.ok) {
      const j = (await info.json()) as { sub?: string; email?: string };
      externalUserId = j.sub ?? null;
      externalEmail = j.email ?? null;
    }
  } catch {
    /* best effort */
  }

  return {
    accessToken: data.access_token!,
    refreshToken: data.refresh_token ?? null,
    tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
    scopes: granted,
    externalUserId,
    externalEmail,
  };
}

/** Google access tokens last about an hour. Used by the Gmail API calls (next stage). */
export async function refreshGmailToken(refreshToken: string) {
  const { clientId, clientSecret } = gmailConfig();
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

export function gmailResultUrl(status: 'connected' | 'denied' | 'error'): string {
  let origin = 'http://localhost:3000';
  try {
    if (process.env.FRONTEND_URL) origin = new URL(process.env.FRONTEND_URL).origin;
  } catch {
    /* keep default */
  }
  return `${origin}/app?integration=gmail&status=${status}`;
}
