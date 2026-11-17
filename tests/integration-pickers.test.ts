import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import type { Integration, PrismaClient } from '@prisma/client';
import { listGoogleCalendars } from '../src/modules/integrations/google-calendar.api';
import {
  createIntegrationPickerService,
  type IntegrationPickerService,
} from '../src/modules/integrations/integration-picker.service';
import { createIntegrationService } from '../src/modules/integrations/integration.service';
import type { ProviderLifecycle } from '../src/modules/integrations/provider-lifecycle';
import type {
  SlackNotificationService,
  SlackPostResult,
} from '../src/modules/integrations/slack-notifications';
import { encryptIntegrationToken } from '../src/modules/integrations/token-crypto';

/**
 * Workspace integration picker tests.
 *
 * Provider HTTP is fully mocked (`fetchImpl`) and the database is a small fake,
 * so these run without network access or PostgreSQL. They cover the security
 * boundary (admin-only), token handling (decrypt/refresh/reconnect), cursor
 * pagination, the exact response shapes, and config validation.
 */

const previousKey = process.env.INTEGRATION_ENCRYPTION_KEY;
process.env.INTEGRATION_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64url');

after(() => {
  if (previousKey === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
  else process.env.INTEGRATION_ENCRYPTION_KEY = previousKey;
});

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const status = init.status ?? 200;
  const headers = Object.fromEntries(
    Object.entries(init.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

function integrationRow(overrides: Partial<Integration> = {}): Integration {
  return {
    id: 'integration-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    provider: 'GOOGLE_CALENDAR',
    status: 'ACTIVE',
    enabled: true,
    accessTokenCiphertext: encryptIntegrationToken('ya29.stored-token'),
    refreshTokenCiphertext: null,
    tokenExpiresAt: null,
    scopes: [],
    externalUserId: null,
    externalEmail: null,
    config: {},
    syncState: {},
    lastError: null,
    lastRefreshedAt: null,
    lastSyncedAt: null,
    revokedAt: null,
    needsReconnect: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as Integration;
}

interface FakeState {
  updates: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  updateManys: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
  findManyCalls: number;
}

function fakePrisma(rows: Integration[], role: 'OWNER' | 'MEMBER'): {
  prisma: PrismaClient;
  state: FakeState;
} {
  const state: FakeState = { updates: [], updateManys: [], findManyCalls: 0 };
  const prisma = {
    workspace: {
      findFirst: async () => ({
        id: 'ws-1',
        deletedAt: null,
        status: 'ACTIVE',
        type: 'COMPANY',
      }),
    },
    workspaceMembership: {
      findUnique: async () => ({
        id: 'membership-1',
        workspaceId: 'ws-1',
        userId: 'user-1',
        role,
        organizationRole: null,
        status: 'ACTIVE',
      }),
    },
    integration: {
      findMany: async () => {
        state.findManyCalls += 1;
        return rows;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        state.updates.push({ where, data });
        const current = rows.find((row) => row.id === where.id) ?? rows[0]!;
        return { ...current, ...data };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        state.updateManys.push({ where, data });
        return { count: 1 };
      },
    },
    auditLog: { create: async () => ({}) },
  } as unknown as PrismaClient;
  return { prisma, state };
}

function fakeLifecycle(refresh: ProviderLifecycle['refresh']): ProviderLifecycle {
  return {
    refresh,
    revoke: async () => ({ revoked: false }),
  };
}

function fakeSlack(
  listChannels: SlackNotificationService['listChannels'],
): SlackNotificationService {
  return {
    listChannels,
  } as unknown as SlackNotificationService;
}

function slackChannels(
  channels: Array<{ id: string; name: string; private: boolean; member: boolean }>,
): SlackNotificationService {
  return fakeSlack(async () => ({ ok: true, channels }));
}

function appErrorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null | undefined)?.code;
}

// ---------------------------------------------------------------------------
// Google Calendar API client
// ---------------------------------------------------------------------------

describe('listGoogleCalendars', () => {
  test('maps calendars and follows the page cursor', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      requests.push({ url: String(url), authorization: headers.Authorization ?? null });
      if (requests.length === 1) {
        return jsonResponse({
          items: [
            { id: 'work@example.com', summary: 'Work', primary: true, accessRole: 'owner' },
            { id: 'personal@example.com', summary: 'Personal', accessRole: 'reader' },
          ],
          nextPageToken: 'page-2',
        });
      }
      return jsonResponse({
        items: [
          {
            id: 'team@example.com',
            summary: 'Ignored summary',
            summaryOverride: 'Team calendar',
            accessRole: 'writer',
          },
        ],
      });
    }) as unknown as typeof fetch;

    const result = await listGoogleCalendars({
      accessToken: 'ya29.test',
      fetchImpl,
      apiBaseUrl: 'https://calendar.example.com/v3/',
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.calendars, [
      { id: 'work@example.com', name: 'Work', primary: true, writable: true },
      { id: 'personal@example.com', name: 'Personal', primary: false, writable: false },
      { id: 'team@example.com', name: 'Team calendar', primary: false, writable: true },
    ]);
    assert.equal(requests.length, 2);
    assert.ok(requests[0]!.url.startsWith('https://calendar.example.com/v3/users/me/calendarList?'));
    assert.ok(requests[0]!.url.includes('maxResults=250'));
    assert.ok(requests[1]!.url.includes('pageToken=page-2'));
    assert.equal(requests[0]!.authorization, 'Bearer ya29.test');
  });

  test('stops at the page cap instead of paging forever', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return jsonResponse({
        items: [{ id: `calendar-${calls}`, summary: `Calendar ${calls}`, accessRole: 'owner' }],
        nextPageToken: `page-${calls + 1}`,
      });
    }) as unknown as typeof fetch;

    const result = await listGoogleCalendars({
      accessToken: 'ya29.test',
      fetchImpl,
      maxPages: 2,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(calls, 2);
    assert.deepEqual(
      result.calendars.map((calendar) => calendar.id),
      ['calendar-1', 'calendar-2'],
    );
  });

  test('classifies 401 as reconnect', async () => {
    const fetchImpl = (async () => jsonResponse({}, { status: 401 })) as unknown as typeof fetch;
    const result = await listGoogleCalendars({ accessToken: 'ya29.test', fetchImpl });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'reconnect');
  });

  test('classifies a missing calendar-list scope as reconnect', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        {
          error: {
            code: 403,
            message: 'Request had insufficient authentication scopes.',
            errors: [{ reason: 'insufficientPermissions' }],
          },
        },
        { status: 403 },
      )) as unknown as typeof fetch;
    const result = await listGoogleCalendars({ accessToken: 'ya29.test', fetchImpl });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'reconnect');
  });

  test('honours Retry-After on 429', async () => {
    const fetchImpl = (async () =>
      jsonResponse({}, { status: 429, headers: { 'retry-after': '5' } })) as unknown as typeof fetch;
    const result = await listGoogleCalendars({ accessToken: 'ya29.test', fetchImpl });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'rate_limited');
    assert.equal(result.retryAfterMs, 5000);
  });

  test('classifies a per-user rate limit as rate_limited', async () => {
    const fetchImpl = (async () =>
      jsonResponse(
        { error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } },
        { status: 403 },
      )) as unknown as typeof fetch;
    const result = await listGoogleCalendars({ accessToken: 'ya29.test', fetchImpl });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'rate_limited');
  });

  test('classifies server failures as unavailable', async () => {
    const fetchImpl = (async () => jsonResponse({}, { status: 500 })) as unknown as typeof fetch;
    const result = await listGoogleCalendars({ accessToken: 'ya29.test', fetchImpl });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'unavailable');
  });

  test('classifies transport failures as unavailable', async () => {
    const fetchImpl = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    const result = await listGoogleCalendars({ accessToken: 'ya29.test', fetchImpl });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'unavailable');
  });
});

// ---------------------------------------------------------------------------
// Picker service — authorization and token handling
// ---------------------------------------------------------------------------

describe('picker authorization', () => {
  test('a member cannot list calendars', async () => {
    const { prisma } = fakePrisma([integrationRow()], 'MEMBER');
    const service = createIntegrationPickerService({
      prisma,
      fetchImpl: (async () => jsonResponse({ items: [] })) as unknown as typeof fetch,
    });

    await assert.rejects(
      () => service.listGoogleCalendars({ userId: 'user-1', workspaceId: 'ws-1' }),
      (error) => appErrorCode(error) === 'INSUFFICIENT_ROLE',
    );
  });

  test('a member cannot list Slack channels', async () => {
    const { prisma } = fakePrisma([integrationRow({ provider: 'SLACK' })], 'MEMBER');
    const service = createIntegrationPickerService({
      prisma,
      slackNotifications: slackChannels([]),
    });

    await assert.rejects(
      () => service.listSlackChannels({ userId: 'user-1', workspaceId: 'ws-1' }),
      (error) => appErrorCode(error) === 'INSUFFICIENT_ROLE',
    );
  });

  test('returns not-connected when the workspace has no calendar connection', async () => {
    const { prisma, state } = fakePrisma([], 'OWNER');
    const service = createIntegrationPickerService({
      prisma,
      fetchImpl: (async () => jsonResponse({ items: [] })) as unknown as typeof fetch,
    });

    await assert.rejects(
      () => service.listGoogleCalendars({ userId: 'user-1', workspaceId: 'ws-1' }),
      (error) => appErrorCode(error) === 'GOOGLE_CALENDAR_NOT_CONNECTED',
    );
    assert.equal(state.findManyCalls, 1);
  });

  test('a connection that needs reconnecting never calls the provider', async () => {
    let providerCalls = 0;
    const { prisma } = fakePrisma([integrationRow({ needsReconnect: true })], 'OWNER');
    const service = createIntegrationPickerService({
      prisma,
      fetchImpl: (async () => {
        providerCalls += 1;
        return jsonResponse({ items: [] });
      }) as unknown as typeof fetch,
    });

    await assert.rejects(
      () => service.listGoogleCalendars({ userId: 'user-1', workspaceId: 'ws-1' }),
      (error) => appErrorCode(error) === 'GOOGLE_CALENDAR_RECONNECT_REQUIRED',
    );
    assert.equal(providerCalls, 0);
  });

  test('a disabled connection is rejected', async () => {
    const { prisma } = fakePrisma([integrationRow({ enabled: false })], 'OWNER');
    const service = createIntegrationPickerService({
      prisma,
      fetchImpl: (async () => jsonResponse({ items: [] })) as unknown as typeof fetch,
    });

    await assert.rejects(
      () => service.listGoogleCalendars({ userId: 'user-1', workspaceId: 'ws-1' }),
      (error) => appErrorCode(error) === 'INTEGRATION_DISABLED',
    );
  });

  test('uses the stored token and never returns it', async () => {
    const authorizations: Array<string | null> = [];
    const { prisma } = fakePrisma([integrationRow()], 'OWNER');
    const service = createIntegrationPickerService({
      prisma,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        authorizations.push(headers.Authorization ?? null);
        return jsonResponse({
          items: [{ id: 'work@example.com', summary: 'Work', primary: true, accessRole: 'owner' }],
        });
      }) as unknown as typeof fetch,
    });

    const calendars = await service.listGoogleCalendars({
      userId: 'user-1',
      workspaceId: 'ws-1',
    });

    assert.deepEqual(calendars, [
      { id: 'work@example.com', name: 'Work', primary: true, writable: true },
    ]);
    assert.deepEqual(authorizations, ['Bearer ya29.stored-token']);
    const serialized = JSON.stringify(calendars);
    assert.ok(!serialized.includes('ya29.stored-token'));
    assert.ok(!serialized.toLowerCase().includes('token'));
  });

  test('refreshes an expired token, re-encrypts it and uses the new token', async () => {
    const refreshes: string[] = [];
    const authorizations: Array<string | null> = [];
    const { prisma, state } = fakePrisma(
      [
        integrationRow({
          tokenExpiresAt: new Date(Date.now() - 60_000),
          refreshTokenCiphertext: encryptIntegrationToken('refresh-token-1'),
        }),
      ],
      'OWNER',
    );
    const service = createIntegrationPickerService({
      prisma,
      lifecycle: fakeLifecycle(async (provider, refreshToken) => {
        refreshes.push(`${provider}:${refreshToken}`);
        return {
          accessToken: 'ya29.refreshed',
          tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        };
      }),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        authorizations.push(headers.Authorization ?? null);
        return jsonResponse({ items: [] });
      }) as unknown as typeof fetch,
    });

    await service.listGoogleCalendars({ userId: 'user-1', workspaceId: 'ws-1' });

    assert.deepEqual(refreshes, ['GOOGLE_CALENDAR:refresh-token-1']);
    assert.deepEqual(authorizations, ['Bearer ya29.refreshed']);
    assert.equal(state.updates.length, 1);
    const data = state.updates[0]!.data as { accessTokenCiphertext: string; needsReconnect: boolean };
    assert.notEqual(data.accessTokenCiphertext, 'ya29.refreshed');
    assert.equal(data.needsReconnect, false);
  });

  test('an expired token with no refresh token requires a reconnect', async () => {
    let providerCalls = 0;
    const { prisma, state } = fakePrisma(
      [integrationRow({ tokenExpiresAt: new Date(Date.now() - 60_000) })],
      'OWNER',
    );
    const service = createIntegrationPickerService({
      prisma,
      fetchImpl: (async () => {
        providerCalls += 1;
        return jsonResponse({ items: [] });
      }) as unknown as typeof fetch,
    });

    await assert.rejects(
      () => service.listGoogleCalendars({ userId: 'user-1', workspaceId: 'ws-1' }),
      (error) => appErrorCode(error) === 'GOOGLE_CALENDAR_RECONNECT_REQUIRED',
    );
    assert.equal(providerCalls, 0);
    assert.ok(
      state.updateManys.some((call) => call.data.needsReconnect === true),
      'the integration should be marked as needing a reconnect',
    );
  });

  test('a rejected token is refreshed once and the request retried', async () => {
    const authorizations: Array<string | null> = [];
    const { prisma } = fakePrisma(
      [integrationRow({ refreshTokenCiphertext: encryptIntegrationToken('refresh-token-2') })],
      'OWNER',
    );
    const service = createIntegrationPickerService({
      prisma,
      lifecycle: fakeLifecycle(async () => ({
        accessToken: 'ya29.after-refresh',
        tokenExpiresAt: null,
      })),
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const headers = init.headers as Record<string, string>;
        authorizations.push(headers.Authorization ?? null);
        if (authorizations.length === 1) return jsonResponse({}, { status: 401 });
        return jsonResponse({ items: [{ id: 'c1', summary: 'C1', accessRole: 'owner' }] });
      }) as unknown as typeof fetch,
    });

    const calendars = await service.listGoogleCalendars({
      userId: 'user-1',
      workspaceId: 'ws-1',
    });

    assert.deepEqual(authorizations, ['Bearer ya29.stored-token', 'Bearer ya29.after-refresh']);
    assert.equal(calendars.length, 1);
  });

  test('a refresh failure marks the connection as needing a reconnect', async () => {
    const { prisma, state } = fakePrisma(
      [
        integrationRow({
          tokenExpiresAt: new Date(Date.now() - 60_000),
          refreshTokenCiphertext: encryptIntegrationToken('refresh-token-3'),
        }),
      ],
      'OWNER',
    );
    const service = createIntegrationPickerService({
      prisma,
      lifecycle: fakeLifecycle(async () => {
        throw new Error('invalid_grant');
      }),
      fetchImpl: (async () => jsonResponse({ items: [] })) as unknown as typeof fetch,
    });

    await assert.rejects(
      () => service.listGoogleCalendars({ userId: 'user-1', workspaceId: 'ws-1' }),
      (error) => appErrorCode(error) === 'GOOGLE_CALENDAR_RECONNECT_REQUIRED',
    );
    assert.ok(state.updateManys.some((call) => call.data.needsReconnect === true));
  });

  test('maps Slack channels to isPrivate and isMember', async () => {
    const { prisma } = fakePrisma([integrationRow({ provider: 'SLACK' })], 'OWNER');
    const service = createIntegrationPickerService({
      prisma,
      slackNotifications: slackChannels([
        { id: 'C1', name: 'general', private: false, member: true },
        { id: 'C2', name: 'ops', private: true, member: false },
      ]),
    });

    const channels = await service.listSlackChannels({
      userId: 'user-1',
      workspaceId: 'ws-1',
    });

    assert.deepEqual(channels, [
      { id: 'C1', name: 'general', isPrivate: false, isMember: true },
      { id: 'C2', name: 'ops', isPrivate: true, isMember: false },
    ]);
  });

  test('a revoked Slack token requires a reconnect', async () => {
    const { prisma, state } = fakePrisma([integrationRow({ provider: 'SLACK' })], 'OWNER');
    const service = createIntegrationPickerService({
      prisma,
      slackNotifications: fakeSlack(async () => ({
        ok: false,
        revoked: true,
        error: 'invalid_auth',
      })),
    });

    await assert.rejects(
      () => service.listSlackChannels({ userId: 'user-1', workspaceId: 'ws-1' }),
      (error) => appErrorCode(error) === 'SLACK_RECONNECT_REQUIRED',
    );
    assert.ok(state.updateManys.some((call) => call.data.needsReconnect === true));
  });

  test('a Slack rate limit is reported as 429 without marking a reconnect', async () => {
    const { prisma, state } = fakePrisma([integrationRow({ provider: 'SLACK' })], 'OWNER');
    const service = createIntegrationPickerService({
      prisma,
      slackNotifications: fakeSlack(async () => ({
        ok: false,
        revoked: false,
        error: 'ratelimited',
        retryAfterMs: 1000,
      })),
    });

    await assert.rejects(
      () => service.listSlackChannels({ userId: 'user-1', workspaceId: 'ws-1' }),
      (error) => appErrorCode(error) === 'SLACK_RATE_LIMITED',
    );
    assert.equal(state.updateManys.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Saved-id validation
// ---------------------------------------------------------------------------

describe('picker selection validation', () => {
  test('accepts a channel the picker returns', async () => {
    const { prisma } = fakePrisma([integrationRow({ provider: 'SLACK' })], 'OWNER');
    const service = createIntegrationPickerService({
      prisma,
      slackNotifications: slackChannels([{ id: 'C1', name: 'general', private: false, member: true }]),
    });

    await service.assertChannelSelectable({
      integration: integrationRow({ provider: 'SLACK' }),
      channelId: 'C1',
    });
  });

  test('rejects a channel the picker does not return', async () => {
    const { prisma } = fakePrisma([integrationRow({ provider: 'SLACK' })], 'OWNER');
    const service = createIntegrationPickerService({
      prisma,
      slackNotifications: slackChannels([{ id: 'C1', name: 'general', private: false, member: true }]),
    });

    await assert.rejects(
      () =>
        service.assertChannelSelectable({
          integration: integrationRow({ provider: 'SLACK' }),
          channelId: 'C-HANDCRAFTED',
        }),
      (error) => appErrorCode(error) === 'SLACK_CHANNEL_NOT_SELECTABLE',
    );
  });

  test('rejects a calendar the picker does not return', async () => {
    const { prisma } = fakePrisma([integrationRow()], 'OWNER');
    const service = createIntegrationPickerService({
      prisma,
      fetchImpl: (async () =>
        jsonResponse({
          items: [{ id: 'work@example.com', summary: 'Work', accessRole: 'owner' }],
        })) as unknown as typeof fetch,
    });

    await assert.rejects(
      () =>
        service.assertCalendarSelectable({
          integration: integrationRow(),
          calendarId: 'other@example.com',
        }),
      (error) => appErrorCode(error) === 'GOOGLE_CALENDAR_NOT_SELECTABLE',
    );
  });

  test('rejects a calendar id on a non-calendar connection', async () => {
    const { prisma } = fakePrisma([integrationRow({ provider: 'SLACK' })], 'OWNER');
    const service = createIntegrationPickerService({ prisma });

    await assert.rejects(
      () =>
        service.assertCalendarSelectable({
          integration: integrationRow({ provider: 'SLACK' }),
          calendarId: 'work@example.com',
        }),
      (error) => appErrorCode(error) === 'INTEGRATION_CONFIG_MISMATCH',
    );
  });
});

// ---------------------------------------------------------------------------
// Config updates must use the picker
// ---------------------------------------------------------------------------

describe('integration config validation', () => {
  const slackIntegration = integrationRow({ provider: 'SLACK' });

  function buildService(
    rows: Integration[],
    picker: Pick<IntegrationPickerService, 'assertCalendarSelectable' | 'assertChannelSelectable'>,
  ) {
    const { prisma, state } = fakePrisma(rows, 'OWNER');
    const service = createIntegrationService(
      prisma,
      fakeLifecycle(async () => null),
      fakeSlack(async () => ({ ok: true, channels: [] })),
      {
        listGoogleCalendars: async () => [],
        listSlackChannels: async () => [],
        ...picker,
      } as IntegrationPickerService,
    );
    return { service, state };
  }

  test('saves a channel id that the picker returns', async () => {
    const { service, state } = buildService([slackIntegration], {
      assertCalendarSelectable: async () => {},
      assertChannelSelectable: async () => {},
    });

    await service.updateConfig({
      userId: 'user-1',
      integrationId: slackIntegration.id,
      config: { slackChannelId: 'C1' },
    });

    assert.equal(state.updates.length, 1);
    assert.deepEqual(state.updates[0]!.data.config, { slackChannelId: 'C1' });
  });

  test('refuses to save a channel id the picker does not return', async () => {
    const { service, state } = buildService([slackIntegration], {
      assertCalendarSelectable: async () => {},
      assertChannelSelectable: async () => {
        const { AppError } = await import('../src/utils/errors');
        throw new AppError(400, 'SLACK_CHANNEL_NOT_SELECTABLE', 'Choose a channel');
      },
    });

    await assert.rejects(
      () =>
        service.updateConfig({
          userId: 'user-1',
          integrationId: slackIntegration.id,
          config: { slackChannelId: 'C-HANDCRAFTED' },
        }),
      (error) => appErrorCode(error) === 'SLACK_CHANNEL_NOT_SELECTABLE',
    );
    assert.equal(state.updates.length, 0);
  });

  test('refuses a Slack channel id on a Google Calendar connection', async () => {
    const calendar = integrationRow();
    const { service, state } = buildService([calendar], {
      assertCalendarSelectable: async () => {},
      assertChannelSelectable: async () => {},
    });

    await assert.rejects(
      () =>
        service.updateConfig({
          userId: 'user-1',
          integrationId: calendar.id,
          config: { slackChannelId: 'C1' },
        }),
      (error) => appErrorCode(error) === 'INTEGRATION_CONFIG_MISMATCH',
    );
    assert.equal(state.updates.length, 0);
  });

  test('refuses an empty calendar id', async () => {
    const calendar = integrationRow();
    const { service, state } = buildService([calendar], {
      assertCalendarSelectable: async () => {},
      assertChannelSelectable: async () => {},
    });

    await assert.rejects(
      () =>
        service.updateConfig({
          userId: 'user-1',
          integrationId: calendar.id,
          config: { googleCalendarId: '   ' },
        }),
      (error) => appErrorCode(error) === 'GOOGLE_CALENDAR_ID_REQUIRED',
    );
    assert.equal(state.updates.length, 0);
  });
});

// Keep the SlackPostResult import meaningful for type-checking of the fake
// success shape without widening the production surface.
const _slackPostShape: SlackPostResult = { ok: true };
void _slackPostShape;
