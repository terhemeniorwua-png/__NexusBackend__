/**
 * Google Calendar API — calendar picker.
 *
 * Lists the calendars the stored OAuth token can see so the workspace can
 * choose which calendar Nexus syncs with. This module performs HTTP only; it
 * receives an already-decrypted access token and never persists or logs it.
 *
 * Pagination: `calendarList.list` returns a `nextPageToken`; callers get every
 * page up to a hard cap so one request cannot turn into unbounded work.
 *
 * Errors are classified so the caller can decide between reconnecting (the
 * token or scope is no longer usable) and retrying later (the provider is
 * temporarily unavailable or rate limiting).
 */

export const DEFAULT_GOOGLE_CALENDAR_API_URL = 'https://www.googleapis.com/calendar/v3';
export const GOOGLE_CALENDAR_REQUEST_TIMEOUT_MS = 10_000;
/** `calendarList.list` allows up to 250 items per page. */
export const GOOGLE_CALENDAR_PAGE_LIMIT = 250;
export const GOOGLE_CALENDAR_MAX_PAGES = 10;

/** The only calendar fields that leave the backend. */
export interface GoogleCalendarOption {
  id: string;
  name: string;
  primary: boolean;
  writable: boolean;
}

export type ListGoogleCalendarsResult =
  | { ok: true; calendars: GoogleCalendarOption[] }
  | {
      ok: false;
      /** `reconnect` means the stored token/scope must be replaced. */
      reason: 'reconnect' | 'rate_limited' | 'unavailable';
      error: string;
      retryAfterMs?: number;
    };

interface CalendarListEntry {
  id?: unknown;
  summary?: unknown;
  summaryOverride?: unknown;
  primary?: unknown;
  accessRole?: unknown;
}

interface CalendarListBody {
  items?: CalendarListEntry[];
  nextPageToken?: unknown;
  error?: {
    message?: unknown;
    errors?: Array<{ reason?: unknown }>;
  };
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 60_000;
}

function providerReason(body: CalendarListBody | null): string {
  const reasons = (body?.error?.errors ?? [])
    .map((entry) => (typeof entry.reason === 'string' ? entry.reason : ''))
    .filter(Boolean);
  if (reasons.length > 0) return reasons.join(',');
  return typeof body?.error?.message === 'string' ? body.error.message.slice(0, 200) : 'unknown_error';
}

/** Reads `accessRole` from Google's CalendarList entry. */
function isWritable(accessRole: unknown): boolean {
  return accessRole === 'owner' || accessRole === 'writer';
}

function toCalendar(entry: CalendarListEntry): GoogleCalendarOption | null {
  if (typeof entry.id !== 'string' || entry.id.length === 0) return null;
  const override = typeof entry.summaryOverride === 'string' ? entry.summaryOverride.trim() : '';
  const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
  return {
    id: entry.id,
    name: override || summary || entry.id,
    primary: entry.primary === true,
    writable: isWritable(entry.accessRole),
  };
}

/**
 * Fetch every calendar visible to `accessToken`, following page cursors.
 *
 * A token that Google rejects (`401`, or `403` with an auth/scope reason) is
 * reported as `reconnect`; rate limits and upstream failures are reported
 * separately so they are not mistaken for a revoked connection.
 */
export async function listGoogleCalendars(input: {
  accessToken: string;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  maxPages?: number;
}): Promise<ListGoogleCalendarsResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = (input.apiBaseUrl ?? DEFAULT_GOOGLE_CALENDAR_API_URL).replace(/\/+$/, '');
  const maxPages = Math.max(1, input.maxPages ?? GOOGLE_CALENDAR_MAX_PAGES);
  const calendars: GoogleCalendarOption[] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${base}/users/me/calendarList`);
    url.searchParams.set('maxResults', String(GOOGLE_CALENDAR_PAGE_LIMIT));
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(GOOGLE_CALENDAR_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        error: error instanceof Error ? error.message.slice(0, 300) : 'The Google request failed',
      };
    }

    if (response.status === 429) {
      return {
        ok: false,
        reason: 'rate_limited',
        error: 'Google is rate limiting calendar listing',
        retryAfterMs: retryAfterMs(response),
      };
    }

    const body = (await response.json().catch(() => null)) as CalendarListBody | null;

    if (!response.ok) {
      const detail = providerReason(body);
      if (response.status === 401) {
        return { ok: false, reason: 'reconnect', error: detail };
      }
      if (response.status === 403) {
        const reconnect =
          /insufficientPermissions|authError|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(detail) ||
          /insufficient|scope/i.test(detail);
        if (reconnect) return { ok: false, reason: 'reconnect', error: detail };
        if (/rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(detail)) {
          return {
            ok: false,
            reason: 'rate_limited',
            error: 'Google is rate limiting calendar listing',
            retryAfterMs: retryAfterMs(response),
          };
        }
      }
      return {
        ok: false,
        reason: 'unavailable',
        error: `Google responded with HTTP ${response.status}: ${detail}`.slice(0, 300),
      };
    }

    if (!body || !Array.isArray(body.items)) {
      return { ok: false, reason: 'unavailable', error: 'Google returned an unexpected response' };
    }

    for (const entry of body.items) {
      const calendar = toCalendar(entry);
      if (calendar) calendars.push(calendar);
    }

    const next = typeof body.nextPageToken === 'string' ? body.nextPageToken : '';
    if (!next) return { ok: true, calendars };
    pageToken = next;
  }

  // The cap was reached with more pages pending; returning what was read keeps
  // the request bounded instead of paging forever.
  return { ok: true, calendars };
}
