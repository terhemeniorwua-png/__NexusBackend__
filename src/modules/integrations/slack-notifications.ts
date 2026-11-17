import type { Integration, IntegrationSyncJob, Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../db/prisma';
import { createNotification } from '../../services/notifications';
import { logger as defaultLogger, type Logger } from '../../utils/logger';
import { decryptIntegrationToken } from './token-crypto';

/**
 * Slack outbound notifications.
 *
 * Slack is a workspace-level integration. Its non-secret channel setting lives
 * in `Integration.config.slackChannelId`. Messages are persisted as
 * `IntegrationSyncJob` rows with type `OUTBOUND_EVENT` before Slack is
 * contacted, so a Slack outage never loses a notification and the durable
 * worker can retry it with backoff.
 *
 * Idempotency: every domain event supplies a stable `dedupeKey`
 * (for example `task.assigned:<taskId>:<assigneeId>:<assignedAt>`). The
 * `(integrationId, dedupeKey)` unique index makes a replayed event a no-op, so
 * a retried producer cannot create duplicate Slack posts for the same event.
 *
 * Revoked tokens: Slack reports `invalid_auth` / `token_revoked` / etc. We
 * mark the integration `needsReconnect`, fail the job without scheduling a
 * retry, and fail any other pending outbound jobs for that integration. New
 * jobs are not enqueued while the integration is not ACTIVE.
 */

export const SLACK_MAX_RETRIES = 5;
export const SLACK_MIN_BACKOFF_MS = 30_000;
export const SLACK_MAX_BACKOFF_MS = 60 * 60_000;
export const SLACK_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_SLACK_API_URL = 'https://slack.com/api';

/**
 * Channel discovery is bounded: a workspace with thousands of channels must not
 * turn one HTTP request into unbounded work. `conversations.list` is paginated
 * with a cursor, and only the first pages are read.
 */
const SLACK_CHANNELS_PAGE_LIMIT = 200;
const SLACK_CHANNELS_MAX_PAGES = 10;

const SLACK_REVOKED_ERRORS = new Set([
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'not_authed',
  'invalid_token',
  'revoked',
]);

export type SlackNotificationKind =
  | 'TASK_ASSIGNED'
  | 'TASK_DUE_SOON'
  | 'TASK_OVERDUE'
  | 'FORM_SUBMITTED'
  | 'AUTOMATION';

export interface SlackNotificationPayload {
  kind: SlackNotificationKind;
  text: string;
  metadata: Record<string, unknown>;
}

export interface EnqueueSlackNotificationInput {
  workspaceId: string;
  kind: SlackNotificationKind;
  dedupeKey: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface EnqueueSlackNotificationResult {
  queued: boolean;
  reason?: 'not_configured' | 'disabled' | 'duplicate';
  jobId?: string;
}

export type SlackJobOutcome = 'succeeded' | 'retried' | 'failed' | 'revoked';

export type SlackNotificationJob = IntegrationSyncJob & { integration: Integration };

export interface SlackPostSuccess {
  ok: true;
  ts?: string;
  channel?: string;
}

export interface SlackPostFailure {
  ok: false;
  retryable: boolean;
  revoked: boolean;
  error: string;
  retryAfterMs?: number;
}

export type SlackPostResult = SlackPostSuccess | SlackPostFailure;

export interface PostSlackMessageInput {
  accessToken: string;
  channel: string;
  text: string;
  fetchImpl?: typeof fetch;
  slackApiUrl?: string;
}

export interface TaskAssignedSlackInput {
  workspaceId: string;
  projectId: string;
  taskId: string;
  taskKey: string;
  taskTitle: string;
  assigneeId: string;
  /** Current task status. Rendered as the `Status:` line. */
  status?: string | null;
  /** ISO timestamp of the assignment; part of the idempotency key. */
  assignedAt: string;
}

export interface TaskDueSoonSlackInput {
  workspaceId: string;
  projectId: string;
  taskId: string;
  taskKey: string;
  taskTitle: string;
  status?: string | null;
  /** ISO timestamp recorded when the due-soon claim was made. */
  dueSoonNotifiedAt: string;
}

export interface TaskOverdueSlackInput {
  workspaceId: string;
  projectId: string;
  taskId: string;
  taskKey: string;
  taskTitle: string;
  status?: string | null;
  /** ISO timestamp of the task due date; part of the idempotency key. */
  dueDate: string;
}

export interface AutomationRunSlackInput {
  workspaceId: string;
  automationId: string;
  automationName: string;
  runId: string;
  trigger: string;
  action: string;
  status: 'SUCCEEDED' | 'FAILED';
  error?: string | null;
}

export interface FormSubmittedSlackInput {
  workspaceId: string;
  formId: string;
  formTitle: string;
  /** One response per submit; part of the idempotency key. */
  responseId: string;
}

export interface AutomationActionSlackInput {
  workspaceId: string;
  automationId: string;
  automationName: string;
  runId: string;
  trigger: string;
}

export interface SlackNotificationServiceDependencies {
  prisma?: PrismaClient;
  logger?: Logger;
  fetchImpl?: typeof fetch;
  slackApiUrl?: string;
  maxRetries?: number;
  backoffFor?: (attempts: number) => number;
}

export interface SlackNotificationService {
  enqueue(input: EnqueueSlackNotificationInput): Promise<EnqueueSlackNotificationResult>;
  enqueueTaskAssigned(input: TaskAssignedSlackInput): Promise<EnqueueSlackNotificationResult>;
  enqueueTaskDueSoon(input: TaskDueSoonSlackInput): Promise<EnqueueSlackNotificationResult>;
  enqueueTaskOverdue(input: TaskOverdueSlackInput): Promise<EnqueueSlackNotificationResult>;
  enqueueFormSubmitted(input: FormSubmittedSlackInput): Promise<EnqueueSlackNotificationResult>;
  enqueueAutomationRun(input: AutomationRunSlackInput): Promise<EnqueueSlackNotificationResult>;
  enqueueAutomationAction(input: AutomationActionSlackInput): Promise<EnqueueSlackNotificationResult>;
  listChannels(input: { accessToken: string }): Promise<ListSlackChannelsResult>;
  processJob(job: SlackNotificationJob, now: Date): Promise<SlackJobOutcome>;
}

export interface SlackChannel {
  id: string;
  name: string;
  private: boolean;
  member: boolean;
}

export type ListSlackChannelsResult =
  | { ok: true; channels: SlackChannel[] }
  | { ok: false; revoked: boolean; error: string; retryAfterMs?: number };

export function slackBackoffFor(attempts: number): number {
  const delay = SLACK_MIN_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(delay, SLACK_MAX_BACKOFF_MS);
}

export function isSlackRevokedError(error: string | null | undefined): boolean {
  if (!error) return false;
  return SLACK_REVOKED_ERRORS.has(error);
}

/** Slack channel id is stored as non-secret integration config. */
export function slackChannelFromConfig(
  config: Prisma.JsonValue | null | undefined,
): string | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const value = (config as Record<string, unknown>).slackChannelId;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function frontendBaseUrl(): string {
  return (process.env.FRONTEND_URL ?? '').replace(/\/+$/, '');
}

export function buildSlackTaskUrl(projectId: string, taskId: string): string {
  const base = frontendBaseUrl();
  const path = (
    process.env.TASK_ASSIGNMENT_LINK_PATH ?? '/projects/:projectId/tasks/:taskId'
  )
    .replace(':projectId', encodeURIComponent(projectId))
    .replace(':taskId', encodeURIComponent(taskId));
  return `${base}${path}`;
}

/**
 * Deep link for a form.
 *
 * The frontend route is `/app/forms/[formId]` and resolves the workspace from
 * the client-side active workspace, so no workspace id is added to the path or
 * query string. The link only resolves when the recipient's active workspace
 * matches the form's workspace.
 */
export function buildSlackFormUrl(formId: string): string {
  return `${frontendBaseUrl()}/app/forms/${encodeURIComponent(formId)}`;
}

function slackLink(url: string, text: string): string {
  return `<${url}|${text}>`;
}

const SLACK_TEXT_LIMIT = 300;

/**
 * Escape user-provided text for Slack `mrkdwn`.
 *
 * Workspace content reaches Slack as plain text only: `<`, `>` and `&` are
 * escaped so a task title cannot inject a Slack mention or link, and control
 * characters are collapsed so a title cannot forge extra lines. Truncation
 * keeps a hostile title from dominating the message.
 */
export function escapeSlackText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, SLACK_TEXT_LIMIT);
}

/**
 * The only task message shape that may be posted to Slack.
 *
 * Product rule: a Slack notification carries the task title, its current
 * status and a deep link. Descriptions, comments, attachments and form
 * answers are never sent.
 */
export function slackTaskMessage(input: {
  taskKey: string;
  taskTitle: string;
  status: string;
  url: string;
}): string {
  const title = escapeSlackText(`${input.taskKey} ${input.taskTitle}`.trim());
  return [
    `*${title}*`,
    `Status: ${escapeSlackText(input.status)}`,
    slackLink(input.url, 'Open task'),
  ].join('\n');
}

/**
 * The only form message shape that may be posted to Slack.
 *
 * Product rule: a form notification carries the form name and a deep link.
 * Submitted answers are never sent.
 */
export function slackFormMessage(input: { formTitle: string; url: string }): string {
  return [
    `*${escapeSlackText(input.formTitle)}*`,
    slackLink(input.url, 'Open form'),
  ].join('\n');
}

/**
 * Post one message to Slack. Slack returns HTTP 200 with `ok:false` for API
 * errors, so both the HTTP status and the body are inspected. Auth failures
 * are reported as `revoked` so the caller can stop retrying and require a
 * reconnect.
 */
export async function postSlackMessage(
  input: PostSlackMessageInput,
): Promise<SlackPostResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = (input.slackApiUrl ?? DEFAULT_SLACK_API_URL).replace(/\/+$/, '');
  let response: Response;
  try {
    response = await fetchImpl(`${base}/chat.postMessage`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: input.channel,
        text: input.text,
        unfurl_links: false,
      }),
      signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      revoked: false,
      error: error instanceof Error ? error.message.slice(0, 300) : 'The Slack request failed',
    };
  }

  if (response.status === 429) {
    const retryAfterSeconds = Number(response.headers.get('retry-after'));
    return {
      ok: false,
      retryable: true,
      revoked: false,
      error: 'Slack rate limit exceeded',
      retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : SLACK_MIN_BACKOFF_MS,
    };
  }

  const body = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    ts?: string;
    channel?: string;
  } | null;

  if (response.ok && body?.ok) {
    return {
      ok: true,
      ...(body.ts ? { ts: body.ts } : {}),
      ...(body.channel ? { channel: body.channel } : {}),
    };
  }

  const slackError = body?.error ?? (response.ok ? 'unknown_error' : `http_${response.status}`);
  const revoked = response.status === 401 || isSlackRevokedError(slackError);
  const retryable =
    !revoked &&
    (response.status === 408 ||
      response.status === 422 ||
      response.status >= 500 ||
      slackError === 'ratelimited');
  return { ok: false, retryable, revoked, error: slackError };
}

/**
 * List the public channels the bot can post to.
 *
 * `channels:read` only exposes public channels and the `is_member` flag. Private
 * channels are excluded from the Slack response entirely, so Nexus never
 * invents a channel the bot cannot address. Pagination is bounded (see
 * `SLACK_CHANNELS_MAX_PAGES`) to keep one request cheap.
 */
export async function listSlackChannels(input: {
  accessToken: string;
  fetchImpl?: typeof fetch;
  slackApiUrl?: string;
}): Promise<ListSlackChannelsResult> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = (input.slackApiUrl ?? DEFAULT_SLACK_API_URL).replace(/\/+$/, '');
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < SLACK_CHANNELS_MAX_PAGES; page += 1) {
    if (cursor === '') break;
    const params = new URLSearchParams({
      types: 'public_channel',
      exclude_archived: 'true',
      limit: String(SLACK_CHANNELS_PAGE_LIMIT),
    });
    if (cursor) params.set('cursor', cursor);

    let response: Response;
    try {
      response = await fetchImpl(`${base}/conversations.list?${params.toString()}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${input.accessToken}` },
        signal: AbortSignal.timeout(SLACK_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return {
        ok: false,
        revoked: false,
        error: error instanceof Error ? error.message.slice(0, 300) : 'The Slack request failed',
      };
    }

    if (response.status === 429) {
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      return {
        ok: false,
        revoked: false,
        error: 'Slack rate limit exceeded',
        retryAfterMs:
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : SLACK_MIN_BACKOFF_MS,
      };
    }

    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      channels?: Array<{
        id?: string;
        name?: string;
        is_private?: boolean;
        is_member?: boolean;
      }>;
      response_metadata?: { next_cursor?: string };
    } | null;

    if (!response.ok || !body?.ok) {
      const slackError = body?.error ?? (response.ok ? 'unknown_error' : `http_${response.status}`);
      return {
        ok: false,
        revoked: response.status === 401 || isSlackRevokedError(slackError),
        error: slackError,
      };
    }

    for (const channel of body.channels ?? []) {
      if (!channel || typeof channel.id !== 'string' || channel.id.length === 0) continue;
      channels.push({
        id: channel.id,
        name: typeof channel.name === 'string' ? channel.name : channel.id,
        private: channel.is_private === true,
        member: channel.is_member === true,
      });
    }

    cursor = body.response_metadata?.next_cursor ?? '';
  }

  return { ok: true, channels };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'P2002') return true;
  return /unique constraint/i.test((error as Error).message ?? '');
}

export function createSlackNotificationService(
  deps: SlackNotificationServiceDependencies = {},
): SlackNotificationService {
  const prisma = deps.prisma ?? getPrismaClient();
  const log = deps.logger ?? defaultLogger;
  const maxRetries = Math.max(1, deps.maxRetries ?? SLACK_MAX_RETRIES);
  const backoffFor = deps.backoffFor ?? slackBackoffFor;

  async function enqueue(input: EnqueueSlackNotificationInput): Promise<EnqueueSlackNotificationResult> {
    const integration = await prisma.integration.findFirst({
      where: {
        workspaceId: input.workspaceId,
        provider: 'SLACK',
        status: 'ACTIVE',
        enabled: true,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, config: true },
    });

    if (!integration) return { queued: false, reason: 'not_configured' };

    const config = (integration.config ?? {}) as Record<string, unknown>;
    if (config.notificationsEnabled === false) {
      return { queued: false, reason: 'disabled' };
    }
    if (!slackChannelFromConfig(integration.config)) {
      return { queued: false, reason: 'not_configured' };
    }

    try {
      const job = await prisma.integrationSyncJob.create({
        data: {
          integrationId: integration.id,
          type: 'OUTBOUND_EVENT',
          dedupeKey: input.dedupeKey,
          payload: {
            kind: input.kind,
            text: input.text,
            metadata: input.metadata ?? {},
          } as Prisma.InputJsonValue,
          maxRetries,
        },
        select: { id: true },
      });
      return { queued: true, jobId: job.id };
    } catch (error) {
      if (isUniqueViolation(error)) return { queued: false, reason: 'duplicate' };
      throw error;
    }
  }

  async function failJob(
    job: SlackNotificationJob,
    now: Date,
    error: string,
  ): Promise<void> {
    await prisma.integrationSyncJob.updateMany({
      where: { id: job.id, status: { in: ['RUNNING', 'PENDING'] } },
      data: {
        status: 'FAILED',
        completedAt: now,
        attempts: job.attempts + 1,
        lastError: error.slice(0, 500),
      },
    });
  }

  /**
   * Record the revoked-token state and tell the workspace once.
   *
   * `updateMany ... needsReconnect: false` is a compare-and-set: only the first
   * job that observes the revocation notifies members, so a burst of failed
   * jobs cannot spam the workspace. Slack is workspace-level, so every ACTIVE
   * member is a legitimate recipient of the reconnect notice.
   */
  async function markReconnectRequired(
    integration: Integration,
    message: string,
  ): Promise<void> {
    const claimed = await prisma.integration.updateMany({
      where: { id: integration.id, needsReconnect: false },
      data: {
        status: 'ERROR',
        needsReconnect: true,
        lastError: message.slice(0, 500),
      },
    });
    if (claimed.count === 0) {
      await prisma.integration.updateMany({
        where: { id: integration.id },
        data: { status: 'ERROR', lastError: message.slice(0, 500) },
      });
      return;
    }

    if (!integration.workspaceId) return;
    try {
      const members = await prisma.workspaceMembership.findMany({
        where: { workspaceId: integration.workspaceId, status: 'ACTIVE' },
        select: { userId: true },
      });
      for (const member of members) {
        await createNotification(prisma, {
          userId: member.userId,
          type: 'INTEGRATION_RECONNECT_REQUIRED',
          title: 'Reconnect Slack',
          body: 'Slack stopped accepting Nexus notifications because the connection was revoked. Reconnect Slack to resume delivery.',
          link: '/settings/integrations',
          data: {
            workspaceId: integration.workspaceId,
            integrationId: integration.id,
            provider: 'SLACK',
          },
        });
      }
    } catch (error) {
      // The revocation state is already persisted; a notification failure must
      // not turn into a job failure that is retried forever.
      log.warn('slack_reconnect_notification_failed', {
        integrationId: integration.id,
        workspaceId: integration.workspaceId,
        error,
      });
    }
  }

  async function processJob(
    job: SlackNotificationJob,
    now: Date,
  ): Promise<SlackJobOutcome> {
    const integration = job.integration;
    if (!integration || integration.status === 'DISCONNECTED' || !integration.enabled) {
      await failJob(job, now, 'The Slack integration is disabled or disconnected');
      return 'failed';
    }
    if (integration.needsReconnect) {
      await failJob(job, now, 'SLACK_RECONNECT_REQUIRED: the stored token was revoked');
      return 'failed';
    }

    const channel = slackChannelFromConfig(integration.config);
    if (!channel) {
      await failJob(job, now, 'SLACK_CHANNEL_NOT_CONFIGURED: set slackChannelId for the workspace');
      return 'failed';
    }

    const payload = (job.payload ?? {}) as Partial<SlackNotificationPayload>;
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text.trim()) {
      await failJob(job, now, 'SLACK_NOTIFICATION_EMPTY: the queued message had no text');
      return 'failed';
    }

    let accessToken: string;
    try {
      accessToken = decryptIntegrationToken(integration.accessTokenCiphertext);
    } catch (error) {
      await failJob(
        job,
        now,
        `SLACK_TOKEN_UNREADABLE: ${error instanceof Error ? error.message : 'token decryption failed'}`,
      );
      return 'failed';
    }

    const posted = await postSlackMessage({
      accessToken,
      channel,
      text,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.slackApiUrl ? { slackApiUrl: deps.slackApiUrl } : {}),
    });

    if (posted.ok) {
      await prisma.integrationSyncJob.updateMany({
        where: { id: job.id, status: { in: ['RUNNING', 'PENDING'] } },
        data: {
          status: 'SUCCEEDED',
          completedAt: now,
          attempts: job.attempts + 1,
          lastError: null,
          result: {
            ok: true,
            ...(posted.ts ? { ts: posted.ts } : {}),
            ...(posted.channel ? { channel: posted.channel } : {}),
          } as Prisma.InputJsonValue,
        },
      });
      return 'succeeded';
    }

    if (posted.revoked) {
      const message = `SLACK_TOKEN_REVOKED: ${posted.error}`;
      await markReconnectRequired(integration, message);
      await failJob(job, now, message);
      // Stop retrying every other queued message for this integration.
      await prisma.integrationSyncJob.updateMany({
        where: { integrationId: integration.id, status: 'PENDING' },
        data: {
          status: 'FAILED',
          completedAt: now,
          lastError: 'SLACK_RECONNECT_REQUIRED: the stored token was revoked',
        },
      });
      log.warn('slack_token_revoked', {
        integrationId: integration.id,
        workspaceId: integration.workspaceId,
        jobId: job.id,
        error: posted.error,
      });
      return 'revoked';
    }

    const attempts = job.attempts + 1;
    const message = `SLACK_POST_FAILED: ${posted.error}`;
    if (posted.retryable && attempts < Math.max(1, job.maxRetries)) {
      const delay = posted.retryAfterMs ?? backoffFor(attempts);
      await prisma.integrationSyncJob.updateMany({
        where: { id: job.id, status: { in: ['RUNNING', 'PENDING'] } },
        data: {
          status: 'PENDING',
          attempts,
          lastError: message.slice(0, 500),
          nextAttemptAt: new Date(now.getTime() + delay),
        },
      });
      log.warn('slack_notification_retry_scheduled', {
        integrationId: integration.id,
        jobId: job.id,
        attempts,
        delayMs: delay,
        error: posted.error,
      });
      return 'retried';
    }

    await failJob(job, now, message);
    await prisma.integration.update({
      where: { id: integration.id },
      data: { lastError: message.slice(0, 500) },
    });
    log.error('slack_notification_failed', {
      integrationId: integration.id,
      jobId: job.id,
      attempts,
      error: posted.error,
    });
    return 'failed';
  }

  return {
    enqueue,
    async enqueueTaskAssigned(input) {
      return enqueue({
        workspaceId: input.workspaceId,
        kind: 'TASK_ASSIGNED',
        dedupeKey: `task.assigned:${input.taskId}:${input.assigneeId}:${input.assignedAt}`,
        text: slackTaskMessage({
          taskKey: input.taskKey,
          taskTitle: input.taskTitle,
          status: input.status ?? 'ASSIGNED',
          url: buildSlackTaskUrl(input.projectId, input.taskId),
        }),
        metadata: {
          projectId: input.projectId,
          taskId: input.taskId,
          assigneeId: input.assigneeId,
          assignedAt: input.assignedAt,
        },
      });
    },
    async enqueueTaskDueSoon(input) {
      return enqueue({
        workspaceId: input.workspaceId,
        kind: 'TASK_DUE_SOON',
        dedupeKey: `task.due-soon:${input.taskId}:${input.dueSoonNotifiedAt}`,
        text: slackTaskMessage({
          taskKey: input.taskKey,
          taskTitle: input.taskTitle,
          status: input.status ? `${input.status} (due within 24 hours)` : 'Due within 24 hours',
          url: buildSlackTaskUrl(input.projectId, input.taskId),
        }),
        metadata: {
          projectId: input.projectId,
          taskId: input.taskId,
          dueSoonNotifiedAt: input.dueSoonNotifiedAt,
        },
      });
    },
    async enqueueTaskOverdue(input) {
      return enqueue({
        workspaceId: input.workspaceId,
        kind: 'TASK_OVERDUE',
        dedupeKey: `task.overdue:${input.taskId}:${input.dueDate}`,
        text: slackTaskMessage({
          taskKey: input.taskKey,
          taskTitle: input.taskTitle,
          status: input.status ? `${input.status} (overdue)` : 'Overdue',
          url: buildSlackTaskUrl(input.projectId, input.taskId),
        }),
        metadata: {
          projectId: input.projectId,
          taskId: input.taskId,
          dueDate: input.dueDate,
        },
      });
    },
    async enqueueFormSubmitted(input) {
      return enqueue({
        workspaceId: input.workspaceId,
        kind: 'FORM_SUBMITTED',
        dedupeKey: `form.submitted:${input.formId}:${input.responseId}`,
        text: slackFormMessage({
          formTitle: input.formTitle,
          url: buildSlackFormUrl(input.formId),
        }),
        metadata: {
          formId: input.formId,
          responseId: input.responseId,
        },
      });
    },
    async enqueueAutomationRun(input) {
      // Automation messages never include the run error text: it can contain
      // workspace content (task titles, comment bodies, form answers).
      const lines = [
        `*${escapeSlackText(input.automationName)}*`,
        `Status: ${input.status === 'SUCCEEDED' ? 'Succeeded' : 'Failed'}`,
        `Trigger: ${escapeSlackText(input.trigger)}`,
        `Action: ${escapeSlackText(input.action)}`,
      ];
      return enqueue({
        workspaceId: input.workspaceId,
        kind: 'AUTOMATION',
        dedupeKey: `automation-run:${input.runId}`,
        text: lines.join('\n'),
        metadata: {
          automationId: input.automationId,
          runId: input.runId,
          status: input.status,
        },
      });
    },
    async enqueueAutomationAction(input) {
      // Explicit automation action: announce that the automation fired. The
      // message is generated from the automation name and trigger only; run
      // payloads and error text are never forwarded to Slack.
      const lines = [
        `*${escapeSlackText(input.automationName)}*`,
        'Status: Triggered',
        `Trigger: ${escapeSlackText(input.trigger)}`,
      ];
      return enqueue({
        workspaceId: input.workspaceId,
        kind: 'AUTOMATION',
        dedupeKey: `automation-action:${input.runId}`,
        text: lines.join('\n'),
        metadata: {
          automationId: input.automationId,
          runId: input.runId,
        },
      });
    },
    async listChannels(input) {
      return listSlackChannels({
        accessToken: input.accessToken,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.slackApiUrl ? { slackApiUrl: deps.slackApiUrl } : {}),
      });
    },
    processJob,
  };
}