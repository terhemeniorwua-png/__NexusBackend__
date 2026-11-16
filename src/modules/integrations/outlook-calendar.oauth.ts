import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getRedisClient } from '../../db/redis';
import { AppError } from '../../utils/errors';

const OUTLOOK_API_SCOPES = ['Calendars.ReadWrite', 'User.Read'];
const OUTLOOK_SCOPES = [...OUTLOOK_API_SCOPES, 'openid', 'email', 'profile', 'offline_access'];
const STATE_TTL_MS = 10 * 60 * 1000;

export const outlookAuthorizeQuerySchema = z.object({ workspaceId: z.string().uuid().optional() });
export const outlookCallbackQuerySchema = z.object({
  code: z.string().min(1).max(4000).optional(),
  state: z.string().min(1).max(2000),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});

function outlookConfig() {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;
  const redirectUri = process.env.MICROSOFT_REDIRECT_URI;
  const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
  const graphBase = process.env.MICROSOFT_GRAPH_BASE_URL || 'https://graph.microsoft.com/v1.0';
  if (!clientId || !clientSecret || !redirectUri) {
    throw new AppError(503, 'OUTLOOK_CALENDAR_NOT_CONFIGURED', 'The Outlook Calendar integration is not configured');
  }
  return { clientId, clientSecret, redirectUri, tenant, graphBase };
}

function stateKey(): Buffer {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new AppError(503, 'OUTLOOK_CALENDAR_NOT_CONFIGURED', 'The Outlook Calendar integration is not configured');
  }
  return createHash('sha256').update(`outlook-calendar-oauth-state:${secret}`).digest();
}

function sign(body: string): string {
  return createHmac('sha256', stateKey()).update(body).digest('base64url');
}

export async function buildOutlookAuthorizeUrl(input: { userId: string }): Promise<string> {
  const { clientId, redirectUri, tenant } = outlookConfig();
  const nonce = randomBytes(16).toString('hex');
  await getRedisClient().set(`outlookcal:oauth:state:${nonce}`, input.userId, { EX: STATE_TTL_MS / 1000 });
  const body = Buffer.from(
    JSON.stringify({ u: input.userId, n: nonce, e: Date.now() + STATE_TTL_MS }),
  ).toString('base64url');
  const state = `${body}.${sign(body)}`;

  const url = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', OUTLOOK_SCOPES.join(' '));
  url.searchParams.set('prompt', 'select_account');
  url.searchParams.set('state', state);
  return url.toString();
}

export async function verifyOutlookState(state: string): Promise<{ userId: string }> {
  const [body, sig, extra] = state.split('.');
  const bad = () =>
    new AppError(400, 'OUTLOOK_CALENDAR_STATE_INVALID', 'The Outlook Calendar authorization link is invalid or expired');
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
  const consumed = await getRedisClient().del(`outlookcal:oauth:state:${claims.n}`);
  if (consumed !== 1) throw bad();
  return { userId: claims.u };
}

interface MicrosoftTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}

async function postToken(params: Record<string, string>): Promise<MicrosoftTokenResponse> {
  const { tenant } = outlookConfig();
  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json().catch(() => ({}))) as MicrosoftTokenResponse;
  if (!res.ok || !data.access_token) {
    throw new AppError(502, 'OUTLOOK_CALENDAR_OAUTH_FAILED', `Microsoft rejected the request (${data.error ?? res.status})`);
  }
  return data;
}

export async function exchangeOutlookCode(code: string) {
  const { clientId, clientSecret, redirectUri, graphBase } = outlookConfig();
  const data = await postToken({
    code,
    grant_type: 'authorization_code',
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    scope: OUTLOOK_SCOPES.join(' '),
  });

  const granted = (data.scope ?? '').split(' ').filter(Boolean);
  const normalized = granted.map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase());
  if (!normalized.includes('calendars.readwrite')) {
    throw new AppError(400, 'OUTLOOK_CALENDAR_SCOPES_MISSING', 'Calendar permission must be granted');
  }

  let externalUserId: string | null = null;
  let externalEmail: string | null = null;
  try {
    const info = await fetch(`${graphBase}/me`, {
      headers: { Authorization: `Bearer ${data.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (info.ok) {
      const j = (await info.json()) as { id?: string; mail?: string | null; userPrincipalName?: string };
      externalUserId = j.id ?? null;
      externalEmail = j.mail ?? j.userPrincipalName ?? null;
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

export async function refreshOutlookToken(refreshToken: string) {
  const { clientId, clientSecret } = outlookConfig();
  const data = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    scope: OUTLOOK_SCOPES.join(' '),
  });
  return {
    accessToken: data.access_token!,
    refreshToken: data.refresh_token ?? refreshToken,
    tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
  };
}

export function outlookResultUrl(status: 'connected' | 'denied' | 'error'): string {
  let origin = 'http://localhost:3000';
  try {
    if (process.env.FRONTEND_URL) origin = new URL(process.env.FRONTEND_URL).origin;
  } catch {
    /* keep default */
  }
  return `${origin}/app/integrations?integration=outlook_calendar&status=${status}`;
}
