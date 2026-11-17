import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { Logger } from '../src/utils/logger';
import {
  createSlackNotificationService,
  escapeSlackText,
  postSlackMessage,
  slackTaskMessage,
} from '../src/modules/integrations/slack-notifications';
import { createSlackEventNotifier } from '../src/modules/integrations/slack.events';

/**
 * Slack delivery unit tests.
 *
 * Slack itself is never called: `postSlackMessage` accepts a `fetchImpl`, and
 * the queue is exercised against a minimal Prisma double so the tests cover the
 * durable-job contract without a database. Workspace isolation and the full
 * job/retry lifecycle live in the database suite.
 */

function silentLogger(): Logger {
  return new Logger('error', {}, () => undefined);
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

interface FakePrismaOptions {
  integration?: { id: string; config: Record<string, unknown> } | null;
  createError?: unknown;
  onCreate?: (data: Record<string, unknown>) => void;
}

function fakePrisma(options: FakePrismaOptions = {}): PrismaClient {
  return {
    integration: {
      findFirst: async () => options.integration ?? null,
    },
    integrationSyncJob: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (options.createError) throw options.createError;
        options.onCreate?.(data);
        return { id: 'job-1' };
      },
    },
  } as unknown as PrismaClient;
}

const taskAssignedInput = {
  workspaceId: 'ws-1',
  projectId: 'project-1',
  taskId: 'task-1',
  taskKey: 'OPS-12',
  taskTitle: 'Fix the login redirect',
  status: 'IN_PROGRESS',
  assigneeId: 'user-2',
  assignedAt: '2026-11-17T09:00:00.000Z',
};

describe('Slack message contract', () => {
  test('a task message carries only title, status and link', () => {
    const text = slackTaskMessage({
      taskKey: 'OPS-12',
      taskTitle: 'Fix the login redirect',
      status: 'IN_PROGRESS',
      url: 'https://app.example.com/projects/p1/tasks/t1',
    });

    const lines = text.split('\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], '*OPS-12 Fix the login redirect*');
    assert.equal(lines[1], 'Status: IN_PROGRESS');
    assert.equal(lines[2], '<https://app.example.com/projects/p1/tasks/t1|Open task>');
  });

  test('titles cannot inject Slack links or extra lines', () => {
    const text = slackTaskMessage({
      taskKey: 'OPS-1',
      taskTitle: '<!channel> see https://evil.example\nStatus: APPROVED',
      status: 'TODO',
      url: 'https://app.example.com/t',
    });

    assert.ok(!text.includes('<!channel>'), 'mentions must be escaped');
    assert.ok(!text.includes('https://evil.example|'), 'raw links must be escaped');
    assert.equal(text.split('\n').length, 3, 'a title cannot forge extra lines');
    assert.ok(text.includes('&lt;!channel&gt;'));
  });

  test('escapeSlackText collapses whitespace and caps length', () => {
    assert.equal(escapeSlackText('  a\n\tb   c  '), 'a b c');
    assert.equal(escapeSlackText('a & b'), 'a &amp; b');
    assert.equal(escapeSlackText('x'.repeat(1000)).length, 300);
  });
});

describe('postSlackMessage', () => {
  test('posts channel, text and disables unfurling', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      captured = { url: String(url), init };
      return jsonResponse({ ok: true, ts: '1700000000.000100', channel: 'C123' });
    }) as unknown as typeof fetch;

    const result = await postSlackMessage({
      accessToken: 'xoxb-test',
      channel: 'C123',
      text: 'hello',
      fetchImpl,
      slackApiUrl: 'https://slack.example.com/api/',
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result, { ok: true, ts: '1700000000.000100', channel: 'C123' });
    assert.ok(captured);
    const request = captured as { url: string; init: RequestInit };
    assert.equal(request.url, 'https://slack.example.com/api/chat.postMessage');
    assert.equal(
      (request.init.headers as Record<string, string>).Authorization,
      'Bearer xoxb-test',
    );
    assert.deepEqual(JSON.parse(String(request.init.body)), {
      channel: 'C123',
      text: 'hello',
      unfurl_links: false,
    });
  });

  test('honours Retry-After on rate limiting', async () => {
    const fetchImpl = (async () =>
      jsonResponse({}, { status: 429, headers: { 'retry-after': '2' } })) as unknown as typeof fetch;

    const result = await postSlackMessage({
      accessToken: 'xoxb-test',
      channel: 'C123',
      text: 'hello',
      fetchImpl,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.retryable, true);
    assert.equal(result.revoked, false);
    assert.equal(result.retryAfterMs, 2000);
  });

  test('classifies revoked tokens so the worker stops retrying', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ ok: false, error: 'token_revoked' })) as unknown as typeof fetch;

    const result = await postSlackMessage({
      accessToken: 'xoxb-test',
      channel: 'C123',
      text: 'hello',
      fetchImpl,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.revoked, true);
    assert.equal(result.retryable, false);
    assert.equal(result.error, 'token_revoked');
  });

  test('treats missing channels as permanent failures', async () => {
    const fetchImpl = (async () =>
      jsonResponse({ ok: false, error: 'channel_not_found' })) as unknown as typeof fetch;

    const result = await postSlackMessage({
      accessToken: 'xoxb-test',
      channel: 'C404',
      text: 'hello',
      fetchImpl,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.revoked, false);
    assert.equal(result.retryable, false);
  });

  test('retries transport errors', async () => {
    const fetchImpl = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;

    const result = await postSlackMessage({
      accessToken: 'xoxb-test',
      channel: 'C123',
      text: 'hello',
      fetchImpl,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.retryable, true);
    assert.equal(result.revoked, false);
  });
});

describe('Slack enqueue', () => {
  test('writes a durable outbound job with a stable dedupe key', async () => {
    let captured: Record<string, unknown> | null = null;
    const service = createSlackNotificationService({
      prisma: fakePrisma({
        integration: { id: 'integration-1', config: { slackChannelId: 'C123' } },
        onCreate: (data) => {
          captured = data;
        },
      }),
      logger: silentLogger(),
    });

    const result = await service.enqueueTaskAssigned(taskAssignedInput);

    assert.deepEqual(result, { queued: true, jobId: 'job-1' });
    assert.ok(captured);
    const job = captured as Record<string, unknown>;
    assert.equal(job.integrationId, 'integration-1');
    assert.equal(job.type, 'OUTBOUND_EVENT');
    assert.equal(
      job.dedupeKey,
      'task.assigned:task-1:user-2:2026-11-17T09:00:00.000Z',
    );
    const payload = job.payload as { kind: string; text: string };
    assert.equal(payload.kind, 'TASK_ASSIGNED');
    assert.equal(payload.text.split('\n').length, 3);
    assert.equal(payload.text.split('\n')[1], 'Status: IN_PROGRESS');
  });

  test('suppresses duplicate events via the unique key', async () => {
    const service = createSlackNotificationService({
      prisma: fakePrisma({
        integration: { id: 'integration-1', config: { slackChannelId: 'C123' } },
        createError: Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      }),
      logger: silentLogger(),
    });

    const result = await service.enqueueTaskDueSoon({
      workspaceId: 'ws-1',
      projectId: 'project-1',
      taskId: 'task-1',
      taskKey: 'OPS-12',
      taskTitle: 'Fix the login redirect',
      status: 'IN_PROGRESS',
      dueSoonNotifiedAt: '2026-11-17T09:00:00.000Z',
    });

    assert.deepEqual(result, { queued: false, reason: 'duplicate' });
  });

  test('posts nothing when the workspace disabled notifications', async () => {
    let created = false;
    const service = createSlackNotificationService({
      prisma: fakePrisma({
        integration: {
          id: 'integration-1',
          config: { slackChannelId: 'C123', notificationsEnabled: false },
        },
        onCreate: () => {
          created = true;
        },
      }),
      logger: silentLogger(),
    });

    const result = await service.enqueueTaskAssigned(taskAssignedInput);

    assert.deepEqual(result, { queued: false, reason: 'disabled' });
    assert.equal(created, false);
  });

  test('posts nothing when no channel is configured', async () => {
    const service = createSlackNotificationService({
      prisma: fakePrisma({ integration: { id: 'integration-1', config: {} } }),
      logger: silentLogger(),
    });

    const result = await service.enqueueTaskAssigned(taskAssignedInput);
    assert.deepEqual(result, { queued: false, reason: 'not_configured' });
  });

  test('posts nothing when the workspace has no Slack integration', async () => {
    const service = createSlackNotificationService({
      prisma: fakePrisma({ integration: null }),
      logger: silentLogger(),
    });

    const result = await service.enqueueTaskAssigned(taskAssignedInput);
    assert.deepEqual(result, { queued: false, reason: 'not_configured' });
  });

  test('automation messages never include the run error text', async () => {
    let captured: Record<string, unknown> | null = null;
    const service = createSlackNotificationService({
      prisma: fakePrisma({
        integration: { id: 'integration-1', config: { slackChannelId: 'C123' } },
        onCreate: (data) => {
          captured = data;
        },
      }),
      logger: silentLogger(),
    });

    await service.enqueueAutomationRun({
      workspaceId: 'ws-1',
      automationId: 'automation-1',
      automationName: 'Notify reviewers',
      runId: 'run-1',
      trigger: 'EVENT_TASK_COMPLETED',
      action: 'SEND_NOTIFICATION',
      status: 'FAILED',
      error: 'Comment body: secret customer data',
    });

    assert.ok(captured);
    const payload = (captured as Record<string, unknown>).payload as { text: string };
    assert.ok(!payload.text.includes('secret customer data'));
    assert.ok(payload.text.includes('Status: Failed'));
  });
});

describe('Slack event notifier', () => {
  test('never fails the calling domain operation', async () => {
    const warnings: string[] = [];
    const notifier = createSlackEventNotifier({
      logger: new Logger('debug', {}, (line) => warnings.push(line)),
      service: {
        enqueueTaskAssigned: async () => {
          throw new Error('queue unavailable');
        },
        enqueueTaskDueSoon: async () => ({ queued: false }),
        enqueueTaskOverdue: async () => ({ queued: false }),
        enqueueAutomationRun: async () => ({ queued: false }),
        enqueue: async () => ({ queued: false }),
        processJob: async () => 'failed',
      },
    });

    await assert.doesNotReject(notifier.taskAssigned(taskAssignedInput));
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0]?.includes('slack_event_enqueue_failed'));
  });

  test('forwards due-soon and overdue events to the queue service', async () => {
    const seen: string[] = [];
    const notifier = createSlackEventNotifier({
      logger: silentLogger(),
      service: {
        enqueueTaskAssigned: async () => ({ queued: true }),
        enqueueTaskDueSoon: async () => {
          seen.push('due_soon');
          return { queued: true };
        },
        enqueueTaskOverdue: async () => {
          seen.push('overdue');
          return { queued: true };
        },
        enqueueAutomationRun: async () => ({ queued: true }),
        enqueue: async () => ({ queued: true }),
        processJob: async () => 'succeeded',
      },
    });

    await notifier.taskDueSoon({
      workspaceId: 'ws-1',
      projectId: 'project-1',
      taskId: 'task-1',
      taskKey: 'OPS-12',
      taskTitle: 'Fix the login redirect',
      status: 'IN_PROGRESS',
      dueSoonNotifiedAt: '2026-11-17T09:00:00.000Z',
    });
    await notifier.taskOverdue({
      workspaceId: 'ws-1',
      projectId: 'project-1',
      taskId: 'task-1',
      taskKey: 'OPS-12',
      taskTitle: 'Fix the login redirect',
      status: 'IN_PROGRESS',
      dueDate: '2026-11-16T09:00:00.000Z',
    });

    assert.deepEqual(seen, ['due_soon', 'overdue']);
  });
});
