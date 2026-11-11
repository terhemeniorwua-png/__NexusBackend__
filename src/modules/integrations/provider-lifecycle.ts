import type { IntegrationProvider } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { refreshDropboxToken } from './dropbox.oauth';
import { refreshGithubToken } from './github.oauth';
import { refreshGmailToken } from './gmail.oauth';
import { refreshCalendarToken } from './google-calendar.oauth';
import { refreshOutlookToken } from './outlook-calendar.oauth';
import { refreshDriveToken } from './google-drive.oauth';
import { onedriveOAuth, outlookMailOAuth } from './microsoft-graph.oauth';

/**
 * Provider lifecycle adapter for Phase 19.
 *
 * Token refresh reuses the existing per-provider OAuth helpers so the refresh
 * grant always matches the same client configuration that issued the token.
 * Revocation is best effort: disconnecting a local record must still succeed
 * when a provider is unreachable or already revoked. Provider-side data is
 * never deleted.
 */

export interface RefreshedToken {
  accessToken: string;
  refreshToken?: string | null;
  tokenExpiresAt?: string | null;
}

export interface RevocationResult {
  revoked: boolean;
  detail?: string;
}

export interface ProviderLifecycle {
  refresh(provider: IntegrationProvider, refreshToken: string): Promise<RefreshedToken | null>;
  revoke(provider: IntegrationProvider, accessToken: string): Promise<RevocationResult>;
}

const REQUEST_TIMEOUT_MS = 10_000;

async function request(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: 'error',
  });
}

function googleRevoke(accessToken: string): Promise<RevocationResult> {
  return request('https://oauth2.googleapis.com/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: accessToken }).toString(),
  }).then((response) => {
    if (response.ok) return { revoked: true };
    return { revoked: false, detail: `Google responded with HTTP ${response.status}` };
  });
}

function dropboxRevoke(accessToken: string): Promise<RevocationResult> {
  return request('https://api.dropboxapi.com/2/auth/token/revoke', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then((response) => {
    if (response.ok) return { revoked: true };
    return { revoked: false, detail: `Dropbox responded with HTTP ${response.status}` };
  });
}

function slackRevoke(accessToken: string): Promise<RevocationResult> {
  return request('https://slack.com/api/auth.revoke', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  }).then(async (response) => {
    if (!response.ok)
      return { revoked: false, detail: `Slack responded with HTTP ${response.status}` };
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (data.ok) return { revoked: true };
    if (data.error === 'token_revoked' || data.error === 'invalid_auth') return { revoked: true };
    return { revoked: false, detail: `Slack rejected the revocation (${data.error ?? 'unknown'})` };
  });
}

function githubRevoke(accessToken: string): Promise<RevocationResult> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return Promise.resolve({
      revoked: false,
      detail: 'GitHub client credentials are not configured',
    });
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  return request(`https://api.github.com/applications/${encodeURIComponent(clientId)}/token`, {
    method: 'DELETE',
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ access_token: accessToken }),
  }).then((response) => {
    if (response.ok || response.status === 404) return { revoked: true };
    return { revoked: false, detail: `GitHub responded with HTTP ${response.status}` };
  });
}

async function defaultRefresh(
  provider: IntegrationProvider,
  refreshToken: string,
): Promise<RefreshedToken | null> {
  switch (provider) {
    case 'GOOGLE_DRIVE':
      return refreshDriveToken(refreshToken);
    case 'GMAIL':
      return refreshGmailToken(refreshToken);
    case 'GOOGLE_CALENDAR':
      return refreshCalendarToken(refreshToken);
    case 'OUTLOOK_CALENDAR':
      return refreshOutlookToken(refreshToken);
    case 'ONEDRIVE':
      return onedriveOAuth.refreshToken(refreshToken);
    case 'OUTLOOK':
      return outlookMailOAuth.refreshToken(refreshToken);
    case 'DROPBOX':
      return refreshDropboxToken(refreshToken);
    case 'GITHUB':
      return refreshGithubToken(refreshToken);
    // OneDrive, Outlook, Outlook Calendar, GitLab and Slack do not expose a
    // refresh flow in the current implementation. Their stored token is used
    // until the provider rejects it, at which point the integration is marked
    // ERROR and the owner must reconnect.
    default:
      return null;
  }
}

export interface ProviderLifecycleOverrides extends Partial<ProviderLifecycle> {
  /** Tests disable live provider calls unless they inject a stub. */
  allowNetwork?: boolean;
}

export function createProviderLifecycle(
  overrides: ProviderLifecycleOverrides = {},
): ProviderLifecycle {
  const allowNetwork = overrides.allowNetwork ?? process.env.NODE_ENV !== 'test';
  return {
    refresh: overrides.refresh ?? defaultRefresh,
    async revoke(provider, accessToken) {
      if (overrides.revoke) return overrides.revoke(provider, accessToken);
      if (!allowNetwork) {
        return {
          revoked: false,
          detail: 'Provider network calls are disabled in this environment',
        };
      }
      try {
        switch (provider) {
          case 'GMAIL':
          case 'GOOGLE_DRIVE':
          case 'GOOGLE_CALENDAR':
            return await googleRevoke(accessToken);
          case 'DROPBOX':
            return await dropboxRevoke(accessToken);
          case 'SLACK':
            return await slackRevoke(accessToken);
          case 'GITHUB':
            return await githubRevoke(accessToken);
          default:
            return {
              revoked: false,
              detail: 'The provider has no revocation endpoint in this implementation',
            };
        }
      } catch (error) {
        return {
          revoked: false,
          detail:
            error instanceof Error ? error.message.slice(0, 200) : 'The revocation request failed',
        };
      }
    },
  };
}

/** Convert a provider refresh failure into a stable integration error code. */
export function toIntegrationError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError(
    502,
    'INTEGRATION_PROVIDER_ERROR',
    error instanceof Error ? error.message.slice(0, 300) : 'The provider request failed',
  );
}
