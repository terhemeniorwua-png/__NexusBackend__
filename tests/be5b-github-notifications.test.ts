import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { recordFanoutEventBestEffort } from '../src/services/notification-fanout';
import type { Logger } from '../src/utils/logger';
import type { NotificationClient } from '../src/services/notifications';

describe('BE-5b GitHub notification fanout helpers', () => {
  test('recordFanoutEventBestEffort never throws when fanout fails', async () => {
    const errors: unknown[] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (...args: unknown[]) => { errors.push(args); },
      error: () => undefined,
    } as unknown as Logger;

    const badClient = {
      workspaceMembership: {
        findMany: async () => { throw new Error('boom'); },
      },
    } as unknown as NotificationClient;

    await recordFanoutEventBestEffort(badClient, {
      action: 'task.github_pr_merged',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      actorId: null,
      targetType: 'Task',
      targetId: 'task-1',
      dedupeKey: 'github_pr_merged:task-1:link-1',
      context: { creatorId: 'u1', assigneeIds: ['u2'], taskTitle: 'T' },
    }, logger);

    assert.ok(errors.length >= 1);
  });
});
