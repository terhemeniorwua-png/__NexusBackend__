import { z } from 'zod';
import { AppError } from '../../utils/errors';
import { createOAuthState, verifyOAuthState } from './oauth-state';

// Minimal scopes for two-way event sync on calendars the user can access.
const CALENDAR_API_SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

export const calendarAuthorizeQuerySchema = z.object({ workspaceId: z.string().uuid() });
export const calendarCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2000).optional(),
  state: z.string().min(1).max(4000),
  error: z.string().max(200).optional(),
});

function calendarConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new AppError(
      503,
      'GOOGLE_CALENDAR_NOT_CONFIGURED',
      'The Google Calendar integration is not configured',
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export async function buildCalendarAuthorizeUrl(input: {
  userId: string;
  workspaceId: string;
}): Promise<string> {
  const { clientId, redirectUri } = calendarConfig();
  const { state, codeChallenge } = await createOAuthState({
    provider: 'google-calendar',
    userId: input.userId,
    workspaceId: input.workspaceId,
    includePkce: true,
  });
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', CALENDAR_API_SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  if (codeChallenge) {
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
  }
  return u.toString();
}

export async function verifyCalendarState(
  state: string,
): Promise<{ userId: string; workspaceId: string; codeVerifier?: string; nonce: string }> {
  const claims = await verifyOAuthState('google-calendar', state);
  if (!claims.workspaceId) {
    throw new AppError(400, 'OAUTH_STATE_INVALID', 'The OAuth state is not valid');
  }
  return {
    userId: claims.userId,
    workspaceId: claims.workspaceId,
    codeVerifier: claims.codeVerifier,
    nonce: claims.nonce,
  };
}

export async function exchangeCalendarCode(input: {
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
  const { clientId, clientSecret, redirectUri } = calendarConfig();
  const params = new URLSearchParams({
    code: input.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
  if (input.codeVerifier) params.set('code_verifier', input.codeVerifier);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  } | null;
  if (!res.ok || !body?.access_token) {
    throw new AppError(502, 'GOOGLE_CALENDAR_OAUTH_FAILED', 'Google did not return an access token');
  }

  let externalUserId: string | null = null;
  let externalEmail: string | null = null;
  try {
    const me = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${body.access_token}` },
    });
    if (me.ok) {
      const profile = (await me.json()) as { id?: string; email?: string };
      externalUserId = profile.id ?? null;
      externalEmail = profile.email ?? null;
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
    scopes: body.scope ? body.scope.split(/\s+/).filter(Boolean) : CALENDAR_API_SCOPES,
    externalUserId,
    externalEmail,
  };
}

export async function refreshCalendarToken(refreshToken: string): Promise<{
  accessToken: string;
  tokenExpiresAt: string | null;
  refreshToken?: string | null;
}> {
  const { clientId, clientSecret } = calendarConfig();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  } | null;
  if (!res.ok || !body?.access_token) {
    throw new AppError(502, 'GOOGLE_CALENDAR_REFRESH_FAILED', 'Google did not refresh the token');
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

export function calendarResultUrl(status: 'connected' | 'denied' | 'error'): string {
  const frontend = (process.env.FRONTEND_URL ?? '').replace(/\/$/, '');
  return `${frontend}/settings/integrations?calendar=${encodeURIComponent(status)}`;
}
