import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  buildCalendarAuthorizeUrl,
  calendarResultUrl,
  verifyCalendarState,
} from '../src/modules/integrations/google-calendar.oauth';

const KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_CALENDAR_REDIRECT_URI',
  'JWT_ACCESS_SECRET',
  'FRONTEND_URL',
  'REDIS_URL',
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env.GOOGLE_CLIENT_ID = 'g-client';
  process.env.GOOGLE_CLIENT_SECRET = 'g-secret';
  process.env.GOOGLE_CALENDAR_REDIRECT_URI = 'http://localhost/cb';
  process.env.JWT_ACCESS_SECRET = 'x'.repeat(40);
  process.env.FRONTEND_URL = 'https://app.example.com';
  delete process.env.REDIS_URL;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test('authorize URL is refused when Google Calendar is not configured', async () => {
  delete process.env.GOOGLE_CALENDAR_REDIRECT_URI;
  await assert.rejects(
    buildCalendarAuthorizeUrl({ userId: 'u1', workspaceId: '11111111-1111-4111-8111-111111111111' }),
    (err: { code?: string }) => err.code === 'GOOGLE_CALENDAR_NOT_CONFIGURED',
  );
});

test('workspace-scoped authorize URL includes PKCE and signed state', async () => {
  const url = new URL(
    await buildCalendarAuthorizeUrl({
      userId: 'u1',
      workspaceId: '11111111-1111-4111-8111-111111111111',
    }),
  );
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('client_id'), 'g-client');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  assert.ok(url.searchParams.get('state'));
});

test('malformed or forged state is rejected', async () => {
  for (const state of ['garbage', 'abc.def', 'a.b.c']) {
    await assert.rejects(verifyCalendarState(state), (err: { code?: string }) =>
      err.code === 'OAUTH_STATE_INVALID' || err.code === 'OAUTH_STATE_EXPIRED',
    );
  }
});

test('tampered state is rejected', async () => {
  const url = new URL(
    await buildCalendarAuthorizeUrl({
      userId: 'u1',
      workspaceId: '11111111-1111-4111-8111-111111111111',
    }),
  );
  const state = url.searchParams.get('state')!;
  await assert.rejects(verifyCalendarState(`${state}tamper`), (err: { code?: string }) =>
    err.code === 'OAUTH_STATE_INVALID' || err.code === 'OAUTH_STATE_EXPIRED',
  );
});

test('result URL points at the frontend integrations page', () => {
  assert.equal(
    calendarResultUrl('connected'),
    'https://app.example.com/settings/integrations?calendar=connected',
  );
});

