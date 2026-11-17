import type { Integration, IntegrationProvider, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { AppError } from '../../utils/errors';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import { requireWorkspaceAccess, WorkspaceCapability } from '../workspaces/authorization';
import { listGoogleCalendars } from './google-calendar.api';
import { createProviderLifecycle, type ProviderLifecycle } from './provider-lifecycle';
import {
  createSlackNotificationService,
  type SlackChannel,
  type SlackNotificationService,
} from './slack-notifications';
import { decryptIntegrationToken, encryptIntegrationToken } from './token-crypto';

/**
 * Workspace integration pickers.
 *
 * Workspace admins need to choose *which* Google calendar or Slack channel
 * Nexus uses. The identifiers are stored as non-secret integration config
 * (`googleCalendarId`, `slackChannelId`), so both the picker endpoints and the
 * config update path must agree on what a valid choice is.
 *
 * Rules enforced here:
 * - Only a workspace manager (`workspace:update`) can list provider resources.
 * - The stored token is decrypted for the provider call only. Tokens are never
 *   returned, logged, or included in error details.
 * - An access token that is expired (or about to expire) is refreshed through
 *   the existing provider lifecycle adapter and the new token is re-encrypted
 *   before it is used. A refresh that cannot succeed marks the connection as
 *   needing a reconnect and fails with a stable "reconnect required" error.
 * - A saved calendar/channel id must be one the picker currently returns.
 *
 * Provider HTTP is injected (`fetchImpl`, `slackNotifications`) so tests never
 * touch the network.
 */

export interface GoogleCalendarPickerItem {
  id: string;
  name: string;
  primary: boolean;
  writable: boolean;
}

export interface SlackChannelPickerItem {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
}

export interface IntegrationPickerService {
  listGoogleCalendars(input: {
    userId: string;
    workspaceId: string;
  }): Promise<GoogleCalendarPickerItem[]>;
  listSlackChannels(input: {
    userId: string;
    workspaceId: string;
  }): Promise<SlackChannelPickerItem[]>;
  /** Rejects a calendar id that the picker would not return for this connection. */
  assertCalendarSelectable(input: {
    integration: Integration;
    calendarId: string;
  }): Promise<void>;
  /** Rejects a channel id that the picker would not return for this connection. */
  assertChannelSelectable(input: {
    integration: Integration;
    channelId: string;
  }): Promise<void>;
}

export interface IntegrationPickerDependencies {
  prisma?: PrismaClient;
  lifecycle?: ProviderLifecycle;
  slackNotifications?: SlackNotificationService;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  googleCalendarApiUrl?: string;
  slackApiUrl?: string;
  now?: () => Date;
}

type PickerProvider = 'GOOGLE_CALENDAR' | 'SLACK';

interface ProviderErrorCodes {
  notConnected: string;
  reconnect: string;
  rateLimited: string;
  unavailable: string;
  notSelectable: string;
}

const ERROR_CODES: Record<PickerProvider, ProviderErrorCodes> = {
  GOOGLE_CALENDAR: {
    notConnected: 'GOOGLE_CALENDAR_NOT_CONNECTED',
    reconnect: 'GOOGLE_CALENDAR_RECONNECT_REQUIRED',
    rateLimited: 'GOOGLE_CALENDAR_RATE_LIMITED',
    unavailable: 'GOOGLE_CALENDAR_LIST_UNAVAILABLE',
    notSelectable: 'GOOGLE_CALENDAR_NOT_SELECTABLE',
  },
  SLACK: {
    notConnected: 'SLACK_NOT_CONNECTED',
    reconnect: 'SLACK_RECONNECT_REQUIRED',
    rateLimited: 'SLACK_RATE_LIMITED',
    unavailable: 'SLACK_CHANNELS_UNAVAILABLE',
    notSelectable: 'SLACK_CHANNEL_NOT_SELECTABLE',
  },
};

const RECONNECT_MESSAGES: Record<PickerProvider, string> = {
  GOOGLE_CALENDAR:
    'Reconnect Google Calendar before choosing a calendar. The stored connection can no longer read the calendar list.',
  SLACK:
    'Reconnect Slack before choosing a channel. The stored connection is no longer accepted by Slack.',
};

const NOT_CONNECTED_MESSAGES: Record<PickerProvider, string> = {
  GOOGLE_CALENDAR: 'Connect Google Calendar to this workspace first',
  SLACK: 'Connect Slack to this workspace first',
};

const NOT_SELECTABLE_MESSAGES: Record<PickerProvider, string> = {
  GOOGLE_CALENDAR: 'Choose a calendar returned by the Google Calendar picker',
  SLACK: 'Choose a channel returned by the Slack picker',
};

/** Refresh slightly before expiry so a token cannot expire mid-request. */
const REFRESH_WINDOW_MS = 5 * 60_000;

interface UsableToken {
  accessToken: string;
  integration: Integration;
}

function isPickerProvider(provider: IntegrationProvider): provider is PickerProvider {
  return provider === 'GOOGLE_CALENDAR' || provider === 'SLACK';
}

export function createIntegrationPickerService(
  deps: IntegrationPickerDependencies = {},
): IntegrationPickerService {
  const prisma = deps.prisma ?? getPrismaClient();
  const log = deps.logger ?? defaultLogger;
  const lifecycle = deps.lifecycle ?? createProviderLifecycle();
  const slackNotifications =
    deps.slackNotifications ??
    createSlackNotificationService({
      prisma,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.slackApiUrl ? { slackApiUrl: deps.slackApiUrl } : {}),
    });
  const now = deps.now ?? (() => new Date());

  async function requireManager(userId: string, workspaceId: string): Promise<void> {
    await requireWorkspaceAccess(prisma, {
      userId,
      workspaceId,
      capability: WorkspaceCapability.UpdateWorkspace,
    });
  }

  /**
   * Load the workspace connection for a picker provider.
   *
   * A workspace can hold more than one row for a provider (each connecting
   * user owns their own row), so prefer a healthy one. Never fall back to
   * another workspace's connection.
   */
  async function loadIntegration(
    provider: PickerProvider,
    workspaceId: string,
  ): Promise<Integration> {
    const rows = await prisma.integration.findMany({
      where: { workspaceId, provider },
      orderBy: { createdAt: 'desc' },
    });
    if (rows.length === 0) {
      throw new AppError(404, ERROR_CODES[provider].notConnected, NOT_CONNECTED_MESSAGES[provider]);
    }
    const healthy = rows.find((row) => row.status === 'ACTIVE' && !row.needsReconnect && row.enabled);
    return healthy ?? rows.find((row) => row.status === 'ACTIVE') ?? rows[0]!;
  }

  function assertUsable(integration: Integration, provider: PickerProvider): void {
    if (!isPickerProvider(integration.provider) || integration.provider !== provider) {
      throw new AppError(
        409,
        ERROR_CODES[provider].notConnected,
        NOT_CONNECTED_MESSAGES[provider],
      );
    }
    if (integration.status === 'DISCONNECTED') {
      throw new AppError(
        409,
        'INTEGRATION_DISCONNECTED',
        'Reconnect the integration before listing provider resources',
      );
    }
    if (integration.needsReconnect) {
      throw new AppError(409, ERROR_CODES[provider].reconnect, RECONNECT_MESSAGES[provider]);
    }
    if (!integration.enabled) {
      throw new AppError(
        409,
        'INTEGRATION_DISABLED',
        'Enable the integration before listing provider resources',
      );
    }
  }

  /**
   * Persist the revoked state once and return the error the caller should see.
   * The compare-and-set keeps a burst of concurrent failures from rewriting the
   * same row repeatedly.
   */
  async function reconnectRequired(
    integration: Integration,
    provider: PickerProvider,
    detail: string,
  ): Promise<AppError> {
    const message = `${ERROR_CODES[provider].reconnect}: ${detail}`.slice(0, 500);
    await prisma.integration.updateMany({
      where: { id: integration.id, needsReconnect: false },
      data: { status: 'ERROR', needsReconnect: true, lastError: message },
    });
    await prisma.integration.updateMany({
      where: { id: integration.id },
      data: { status: 'ERROR', lastError: message },
    });
    log.warn('integration_reconnect_required', {
      integrationId: integration.id,
      workspaceId: integration.workspaceId,
      provider: integration.provider,
      picker: provider,
    });
    return new AppError(409, ERROR_CODES[provider].reconnect, RECONNECT_MESSAGES[provider], {
      cause: detail,
    });
  }

  /** Refresh the access token, or fail with a reconnect-required error. */
  async function refreshOrReconnect(
    integration: Integration,
    provider: PickerProvider,
  ): Promise<UsableToken> {
    if (!integration.refreshTokenCiphertext) {
      throw await reconnectRequired(integration, provider, 'No refresh token is stored');
    }

    let refreshToken: string;
    try {
      refreshToken = decryptIntegrationToken(integration.refreshTokenCiphertext);
    } catch {
      throw await reconnectRequired(integration, provider, 'The stored refresh token is unreadable');
    }

    let refreshed;
    try {
      refreshed = await lifecycle.refresh(integration.provider, refreshToken);
    } catch (error) {
      throw await reconnectRequired(
        integration,
        provider,
        error instanceof Error ? error.message.slice(0, 200) : 'The token refresh failed',
      );
    }
    if (!refreshed) {
      throw await reconnectRequired(
        integration,
        provider,
        'The provider does not expose a token refresh flow',
      );
    }

    const updated = await prisma.integration.update({
      where: { id: integration.id },
      data: {
        accessTokenCiphertext: encryptIntegrationToken(refreshed.accessToken),
        ...(refreshed.refreshToken
          ? { refreshTokenCiphertext: encryptIntegrationToken(refreshed.refreshToken) }
          : {}),
        tokenExpiresAt: refreshed.tokenExpiresAt ? new Date(refreshed.tokenExpiresAt) : null,
        status: 'ACTIVE',
        lastError: null,
        lastRefreshedAt: now(),
        needsReconnect: false,
      },
    });
    return { accessToken: refreshed.accessToken, integration: updated };
  }

  /**
   * Decrypt the stored token, refreshing it first when it is expired or about
   * to expire. A token that is still valid but has no refresh token is used as
   * is; only a genuinely expired token forces a reconnect.
   */
  async function usableToken(
    integration: Integration,
    provider: PickerProvider,
  ): Promise<UsableToken> {
    const current = now();
    const expiresAt = integration.tokenExpiresAt;
    const expiresSoon =
      expiresAt !== null && expiresAt.getTime() - current.getTime() <= REFRESH_WINDOW_MS;

    if (expiresSoon) {
      if (integration.refreshTokenCiphertext) {
        return refreshOrReconnect(integration, provider);
      }
      if (expiresAt !== null && expiresAt.getTime() <= current.getTime()) {
        throw await reconnectRequired(integration, provider, 'The access token has expired');
      }
    }

    let accessToken: string;
    try {
      accessToken = decryptIntegrationToken(integration.accessTokenCiphertext);
    } catch {
      throw await reconnectRequired(integration, provider, 'The stored access token is unreadable');
    }
    return { accessToken, integration };
  }

  function rateLimited(provider: PickerProvider): AppError {
    return new AppError(
      429,
      ERROR_CODES[provider].rateLimited,
      'The provider is rate limiting requests. Try again shortly.',
    );
  }

  function unavailable(provider: PickerProvider): AppError {
    return new AppError(
      502,
      ERROR_CODES[provider].unavailable,
      'The provider did not return a resource list. Try again later.',
    );
  }

  async function calendarsFor(integration: Integration): Promise<GoogleCalendarPickerItem[]> {
    assertUsable(integration, 'GOOGLE_CALENDAR');
    let usable = await usableToken(integration, 'GOOGLE_CALENDAR');
    const fetchOptions = {
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.googleCalendarApiUrl ? { apiBaseUrl: deps.googleCalendarApiUrl } : {}),
    };

    let result = await listGoogleCalendars({ accessToken: usable.accessToken, ...fetchOptions });
    if (!result.ok && result.reason === 'reconnect' && usable.integration.refreshTokenCiphertext) {
      // Google can reject an access token that has not reached its advertised
      // expiry. Refresh once, then retry with the new token.
      usable = await refreshOrReconnect(usable.integration, 'GOOGLE_CALENDAR');
      result = await listGoogleCalendars({ accessToken: usable.accessToken, ...fetchOptions });
    }

    if (!result.ok) {
      if (result.reason === 'reconnect') {
        throw await reconnectRequired(usable.integration, 'GOOGLE_CALENDAR', result.error);
      }
      throw result.reason === 'rate_limited'
        ? rateLimited('GOOGLE_CALENDAR')
        : unavailable('GOOGLE_CALENDAR');
    }
    return result.calendars;
  }

  async function channelsFor(integration: Integration): Promise<SlackChannelPickerItem[]> {
    assertUsable(integration, 'SLACK');
    let usable = await usableToken(integration, 'SLACK');

    let result = await slackNotifications.listChannels({ accessToken: usable.accessToken });
    if (!result.ok && result.revoked && usable.integration.refreshTokenCiphertext) {
      usable = await refreshOrReconnect(usable.integration, 'SLACK');
      result = await slackNotifications.listChannels({ accessToken: usable.accessToken });
    }

    if (!result.ok) {
      if (result.revoked) {
        throw await reconnectRequired(usable.integration, 'SLACK', result.error);
      }
      throw result.retryAfterMs !== undefined ? rateLimited('SLACK') : unavailable('SLACK');
    }
    return result.channels.map((channel: SlackChannel) => ({
      id: channel.id,
      name: channel.name,
      isPrivate: channel.private,
      isMember: channel.member,
    }));
  }

  return {
    async listGoogleCalendars(input) {
      await requireManager(input.userId, input.workspaceId);
      const integration = await loadIntegration('GOOGLE_CALENDAR', input.workspaceId);
      return calendarsFor(integration);
    },

    async listSlackChannels(input) {
      await requireManager(input.userId, input.workspaceId);
      const integration = await loadIntegration('SLACK', input.workspaceId);
      return channelsFor(integration);
    },

    async assertCalendarSelectable(input) {
      if (input.integration.provider !== 'GOOGLE_CALENDAR') {
        throw new AppError(
          400,
          'INTEGRATION_CONFIG_MISMATCH',
          'googleCalendarId is only valid for a Google Calendar connection',
        );
      }
      const calendars = await calendarsFor(input.integration);
      if (!calendars.some((calendar) => calendar.id === input.calendarId)) {
        throw new AppError(
          400,
          ERROR_CODES.GOOGLE_CALENDAR.notSelectable,
          NOT_SELECTABLE_MESSAGES.GOOGLE_CALENDAR,
        );
      }
    },

    async assertChannelSelectable(input) {
      if (input.integration.provider !== 'SLACK') {
        throw new AppError(
          400,
          'INTEGRATION_CONFIG_MISMATCH',
          'slackChannelId is only valid for a Slack connection',
        );
      }
      const channels = await channelsFor(input.integration);
      if (!channels.some((channel) => channel.id === input.channelId)) {
        throw new AppError(400, ERROR_CODES.SLACK.notSelectable, NOT_SELECTABLE_MESSAGES.SLACK);
      }
    },
  };
}
