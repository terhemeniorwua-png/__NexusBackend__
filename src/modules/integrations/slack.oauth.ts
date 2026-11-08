import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getRedisClient } from '../../db/redis';
import { AppError } from '../../utils/errors';

const SLACK_SCOPES = ['chat:write', 'channels:read', 'app_mentions:read'];
const STATE_TTL_MS = 10 * 60 * 1000;

export const slackAuthorizeQuerySchema = z.object({ workspaceId: z.string().uuid() });
export const slackCallbackQuerySchema = z.object({
  code: z.string().min(1).max(500).optional(),
  state: z.string().min(1).max(2000),
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

function stateKey(): Buffer {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new AppError(503, 'SLACK_NOT_CONFIGURED', 'The Slack integration is not configured');
  return createHash('sha256').update(`slack-oauth-state:${secret}`).digest();
}

function sign(body: string): string {
  return createHmac('sha256', stateKey()).update(body).digest('base64url');
}

export async function buildSlackAuthorizeUrl(input: { userId: string; workspaceId: string }): Promise<string> {
  const { clientId, redirectUri } = slackConfig();
  const nonce = randomBytes(16).toString('hex');
  await getRedisClient().set(`slack:oauth:state:${nonce}`, input.userId, { EX: STATE_TTL_MS / 1000 });
  const body = Buffer.from(
    JSON.stringify({ u: input.userId, w: input.workspaceId, n: nonce, e: Date.now() + STATE_TTL_MS }),
  ).toString('base64url');
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', SLACK_SCOPES.join(','));
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', `${body}.${sign(body)}`);
  return url.toString();
}

export async function verifySlackState(state: string): Promise<{ userId: string; workspaceId: string }> {
  const [body, sig, extra] = state.split('.');
  const bad = () => new AppError(400, 'SLACK_STATE_INVALID', 'The Slack authorization link is invalid or expired');
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
  // One-time use: DEL returns 1 only for the first caller; a replayed state gets 0.
  const consumed = await getRedisClient().del(`slack:oauth:state:${claims.n}`);
  if (consumed !== 1) throw bad();
  return { userId: claims.u, workspaceId: claims.w };
}

export async function exchangeSlackCode(code: string) {
  const { clientId, clientSecret, redirectUri } = slackConfig();
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as {
    ok?: boolean; error?: string; access_token?: string; refresh_token?: string;
    expires_in?: number; scope?: string; authed_user?: { id?: string };
  };
  if (!data.ok || !data.access_token) {
    throw new AppError(502, 'SLACK_OAUTH_FAILED', `Slack rejected the authorization (${data.error ?? 'unknown'})`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    tokenExpiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
    scopes: data.scope ? data.scope.split(',') : [],
    externalUserId: data.authed_user?.id ?? null,
  };
}

export function slackResultUrl(status: 'connected' | 'denied' | 'error'): string {
  let origin = 'http://localhost:3000';
  try {
    if (process.env.FRONTEND_URL) origin = new URL(process.env.FRONTEND_URL).origin;
  } catch {
    /* keep default */
  }
  return `${origin}/app?integration=slack&status=${status}`;
}
