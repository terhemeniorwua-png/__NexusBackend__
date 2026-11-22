/* eslint-disable @typescript-eslint/no-explicit-any -- mocked client shapes for unit tests */
// @ts-expect-error vitest types are provided by the vitest runner, not tsconfig.test.json types
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../modules/authorization', () => ({
  ProjectPermission: { SubmissionReview: 'project.submission.review', SubmissionApprove: 'project.submission.approve' },
  effectiveWorkspaceRole: vi.fn(() => 'MEMBER'),
  resolveProjectAuthorization: vi.fn(async () => ({ permissions: [], isWorkspaceAdmin: false, projectRole: 'CONTRIBUTOR' })),
}));

vi.mock('../modules/dev-integrations/repository-access.resolver', () => ({
  resolveRepositoryAccess: vi.fn(),
}));

vi.mock('../realtime/io-registry', () => ({
  emitToUser: vi.fn(),
}));

import { recordFanoutEvent } from './notification-fanout';
import { resolveRepositoryAccess } from '../modules/dev-integrations/repository-access.resolver';

function makeClient(overrides: any = {}) {
  const notifications: any[] = [];
  return {
    notifications,
    client: {
      workspaceMembership: {
        findMany: vi.fn(async () => [
          { userId: 'u-none', status: 'ACTIVE', role: 'MEMBER', organizationRole: null, workspace: { type: 'COMPANY' } },
          { userId: 'u-read', status: 'ACTIVE', role: 'MEMBER', organizationRole: null, workspace: { type: 'COMPANY' } },
        ]),
      },
      taskDevLink: {
        findUnique: vi.fn(async () => ({ projectRepositoryId: 'repo-1', projectId: 'proj-1' })),
      },
      notificationPreference: { findUnique: vi.fn(async () => null) },
      notification: {
        createMany: vi.fn(async ({ data }: any) => {
          notifications.push(...data);
          return { count: data.length };
        }),
        findMany: vi.fn(async () => notifications.map((n: any) => ({ ...n, body: n.body ?? null, link: null, readAt: null, createdAt: new Date() }))),
      },
      ...overrides,
    },
  };
}

describe('BE-9 repo-derived notification filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('excludes NONE users from repo-derived GitHub PR merged fanout', async () => {
    (resolveRepositoryAccess as any).mockImplementation(async (_c: any, p: any) =>
      p.userId === 'u-none' ? 'NONE' : 'READ',
    );
    const { client, notifications } = makeClient();
    await recordFanoutEvent(client as any, {
      action: 'task.github_pr_merged',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      actorId: null,
      targetType: 'Task',
      targetId: 'task-1',
      dedupeKey: 'd1',
      context: { creatorId: 'u-none', assigneeIds: ['u-read'], taskTitle: 'Task', linkId: 'link-1' },
    });
    expect(notifications.map((n: any) => n.userId)).toEqual(['u-read']);
    expect(notifications[0].title).not.toContain('acme');
    expect(notifications[0].body).not.toContain('acme');
  });

  it('excludes NONE users from repo-derived GitHub review fanout', async () => {
    (resolveRepositoryAccess as any).mockImplementation(async (_c: any, p: any) =>
      p.userId === 'u-none' ? 'NONE' : 'READ',
    );
    const { client, notifications } = makeClient();
    await recordFanoutEvent(client as any, {
      action: 'task.github_review_synced',
      workspaceId: 'ws-1',
      projectId: 'proj-1',
      actorId: null,
      targetType: 'TaskDevLink',
      targetId: 'link-1',
      dedupeKey: 'd2',
      context: { creatorId: 'u-none', assigneeIds: ['u-read'], taskTitle: 'Task', linkId: 'link-1' },
    });
    expect(notifications.map((n: any) => n.userId)).toEqual(['u-read']);
  });
});
