import { z } from 'zod';
import { AppError } from '../../utils/errors';
import { createOAuthState, verifyOAuthState } from './oauth-state';

const SLACK_SCOPES = ['chat:write', 'channels:read', 'channels:join'];

export const slackAuthorizeQuerySchema = z.object({ workspaceId: z.string().uuid() });
export const slackCallbackQuerySchema = z.object({
  code: z.string().min(1).max(500).optional(),
  state: z.string().min(1).max(4000),
  error: z.string().max(200).optional(),
});

function slackConfig() {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const redirectUri = process.env.SLACK_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new AppError(503, 'SLACK_NOT_CONFIGURED', 'The Slack integration is not configured');
  }
  return { clientId, clientSecret, redirectUri };
}

/**
 * Opt-in "default connect": instead of sending the user to Slack, the backend stores its own
 * bot token (SLACK_BOT_TOKEN) for the workspace. Intended for internal tools and demos.
 */
export function isSlackDefaultConnectEnabled(): boolean {
  return process.env.SLACK_DEFAULT_CONNECT === 'true' && Boolean(process.env.SLACK_BOT_TOKEN);
}

export async function slackDefaultConnection(): Promise<{
  accessToken: string;
  refreshToken: null;
  tokenExpiresAt: null;
  scopes: string[];
  externalUserId: null;
  externalEmail: null;
}> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (process.env.SLACK_DEFAULT_CONNECT !== 'true' || !token) {
    throw new AppError(503, 'SLACK_NOT_CONFIGURED', 'The default Slack connection is not enabled');
  }
  return {
    accessToken: token,
    refreshToken: null,
    tokenExpiresAt: null,
    scopes: SLACK_SCOPES,
    externalUserId: null,
    externalEmail: null,
  };
}

function defaultCallbackUrl(): URL {
  const redirectUri = process.env.SLACK_REDIRECT_URI;
  if (!redirectUri) throw new AppError(503, 'SLACK_NOT_CONFIGURED', 'The Slack integration is not configured');
  const url = new URL(redirectUri);
  if (!/\/callback$/.test(url.pathname)) {
    throw new AppError(503, 'SLACK_NOT_CONFIGURED', 'SLACK_REDIRECT_URI must end with /callback');
  }
  url.pathname = url.pathname.replace(/\/callback$/, '/default-callback');
  url.search = '';
  return url;
}

export async function buildSlackAuthorizeUrl(input: {
  userId: string;
  workspaceId: string;
}): Promise<string> {
  const defaultMode = isSlackDefaultConnectEnabled();
  const oauth = defaultMode ? null : slackConfig();
  const { state } = await createOAuthState({
    provider: 'slack',
    userId: input.userId,
    workspaceId: input.workspaceId,
  });
  if (defaultMode) {
    const target = defaultCallbackUrl();
    target.searchParams.set('state', state);
    return target.toString();
  }
  const { clientId, redirectUri } = oauth!;
  const u = new URL('https://slack.com/oauth/v2/authorize');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('scope', SLACK_SCOPES.join(','));
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

export async function verifySlackState(
  state: string,
): Promise<{ userId: string; workspaceId: string }> {
  const claims = await verifyOAuthState('slack', state);
  if (!claims.workspaceId) {
    throw new AppError(400, 'OAUTH_STATE_INVALID', 'The OAuth state is not valid');
  }
  return { userId: claims.userId, workspaceId: claims.workspaceId };
}

export async function exchangeSlackCode(code: string): Promise<{
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  scopes: string[];
  externalUserId: string | null;
  externalEmail: string | null;
}> {
  const { clientId, clientSecret, redirectUri } = slackConfig();
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri }),
  });
  const body = (await res.json().catch(() => null)) as {
    ok?: boolean;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    authed_user?: { id?: string };
    team?: { id?: string; name?: string };
    error?: string;
  } | null;
  if (!res.ok || !body?.ok || !body.access_token) {
    throw new AppError(502, 'SLACK_OAUTH_FAILED', 'Slack did not return an access token');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    tokenExpiresAt:
      typeof body.expires_in === 'number' ? new Date(Date.now() + body.expires_in * 1000).toISOString() : null,
    scopes: body.scope ? body.scope.split(',').filter(Boolean) : SLACK_SCOPES,
    externalUserId: body.team?.id ?? body.authed_user?.id ?? null,
    externalEmail: body.team?.name ?? null,
  };
}

export function slackResultUrl(status: 'connected' | 'denied' | 'error'): string {
  let origin = 'http://localhost:3000';
  try {
    if (process.env.FRONTEND_URL) origin = new URL(process.env.FRONTEND_URL).origin;
  } catch {
    /* keep default */
  }
  return `${origin}/app/integrations?integration=slack&status=${status}`;
}
