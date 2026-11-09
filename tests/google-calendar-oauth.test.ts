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
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
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
    buildCalendarAuthorizeUrl({ userId: 'u1' }),
    (err: { code?: string }) => err.code === 'GOOGLE_CALENDAR_NOT_CONFIGURED',
  );
});

test('malformed or forged state is rejected before any Redis access', async () => {
  process.env.JWT_ACCESS_SECRET = 'x'.repeat(40);
  for (const state of ['garbage', 'abc.def', 'a.b.c']) {
    await assert.rejects(
      verifyCalendarState(state),
      (err: { code?: string }) => err.code === 'GOOGLE_CALENDAR_STATE_INVALID',
    );
  }
});

test('result URL points at the frontend integrations page', () => {
  process.env.FRONTEND_URL = 'https://app.example.com/some/path';
  assert.equal(
    calendarResultUrl('connected'),
    'https://app.example.com/app/integrations?integration=google_calendar&status=connected',
  );
});
