/* eslint-disable @typescript-eslint/no-explicit-any */ // Mock prisma objects for webhook unit tests
import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { createHmac } from 'node:crypto';
import { processGithubWebhook } from '../src/modules/dev-integrations/github-webhook.service';

const SECRET = 'be6-webhook-test-secret';

function sign(body: Buffer): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

function payload(pr: Record<string, unknown>, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ repository: { full_name: 'owner/repo' }, pull_request: pr, ...extra }));
}

interface Captured {
  deliveryCreate: any[];
  deliveryUpdate: any[];
  linkFindMany: any[];
  linkUpdateMany: any[];
  linkUpdates: any[];
  taskUpdateMany: any[];
  auditCreates: any[];
}

function buildPrisma({
  links,
  reviewLinks,
  taskStatuses = new Map<string, string>(),
}: {
  links?: any[];
  reviewLinks?: any[];
  taskStatuses?: Map<string, string>;
}): { prisma: any; captured: Captured } {
  const captured: Captured = {
    deliveryCreate: [],
    deliveryUpdate: [],
    linkFindMany: [],
    linkUpdateMany: [],
    linkUpdates: [],
    taskUpdateMany: [],
    auditCreates: [],
  };

  const linksRef = links ?? [];
  const reviewLinksRef = reviewLinks ?? [];

  // Seed current statuses from the link fixtures so each task behaves like its
  // real row (e.g. an ASSIGNED task must not transition).
  const statuses = new Map<string, string>();
  for (const l of [...linksRef, ...reviewLinksRef]) {
    if (l?.task?.status) statuses.set(l.task.id, l.task.status);
  }
  for (const [k, v] of taskStatuses) statuses.set(k, v);

  const tx = {
    taskDevLink: {
      update: async (args: any) => {
        captured.linkUpdates.push(args);
        return {};
      },
      findUnique: async (_args: any) => ({ reviewedAt: null }),
    },
    task: {
      updateMany: async (args: any) => {
        captured.taskUpdateMany.push(args);
        const where = args.where as any;
        const id = where.id;
        const allowed = where.status?.in ?? [];
        const current = statuses.get(id) ?? 'IN_PROGRESS';
        if (allowed.includes(current)) {
          statuses.set(id, 'SUBMITTED');
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
    auditLog: {
      create: async (args: any) => {
        captured.auditCreates.push(args);
        return {};
      },
    },
  };

  const prisma: any = {
    gitHubWebhookDelivery: {
      create: async (args: any) => { captured.deliveryCreate.push(args); return {}; },
      update: async (args: any) => { captured.deliveryUpdate.push(args); return {}; },
    },
    taskDevLink: {
      findMany: async (args: any) => {
        captured.linkFindMany.push(args);
        return linksRef;
      },
      update: async (args: any) => { captured.linkUpdates.push(args); return {}; },
      updateMany: async (args: any) => { captured.linkUpdateMany.push(args); return { count: linksRef.length }; },
    },
    $transaction: async (fn: any) => fn(tx),
  };

  // Wire the review-flow links through a separate findMany so both events can be
  // tested from the same factory when needed.
  const originalFindMany = prisma.taskDevLink.findMany.bind(prisma);
  prisma.taskDevLink.findMany = async (args: any) => {
    const res = await originalFindMany(args);
    if (args.where?.externalType === 'PULL_REQUEST' && reviewLinksRef.length) {
      return reviewLinksRef;
    }
    return res;
  };

  return { prisma, captured };
}

function mergedPr(externalId: number, number: number): Record<string, unknown> {
  return {
    id: externalId,
    number,
    title: 'Fix bug',
    state: 'closed',
    merged: true,
    merged_at: '2026-01-02T00:00:00Z',
    html_url: `https://github.com/owner/repo/pull/${number}`,
    head: { ref: 'fix' },
    base: { ref: 'main' },
  };
}

async function invoke(prisma: any, externalId: number, number: number, deliveryId: string): Promise<string> {
  const body = payload(mergedPr(externalId, number));
  const signature = sign(body);
  return processGithubWebhook({
    prisma,
    rawBody: body,
    signature,
    secret: SECRET,
    deliveryId,
    event: 'pull_request',
  });
}

describe('BE-6 GitHub webhook -> task dev-link sync (ported to node:test)', () => {
  test('merged PR moves linked CHANGES_REQUESTED task to SUBMITTED, submittedById = linkedById, feedback/summary preserved', async () => {
    const links = [{
      id: 'link-1', taskId: 'task-1', externalId: '101', linkedById: 'user-linker-1',
      task: { id: 'task-1', status: 'CHANGES_REQUESTED', key: 'T-1', projectId: 'proj-1', project: { workspaceId: 'ws-1' } },
    }];
    const { prisma, captured } = buildPrisma({ links });
    const out = await invoke(prisma, 101, 12, 'deliv-merge-1');
    assert.strictEqual(out, 'processed');
    assert.strictEqual(captured.deliveryCreate.length, 1);
    assert.strictEqual(captured.deliveryUpdate.length, 1);

    // Bulk link state update keeps prior behaviour.
    assert.ok(captured.linkUpdateMany.some((c: any) =>
      JSON.stringify(c.where) === JSON.stringify({ provider: 'GITHUB', externalType: 'PULL_REQUEST', externalId: '101' }) &&
      c.data.state === 'merged' && c.data.externalNumber === 12 && c.data.title === 'Fix bug' &&
      c.data.headRef === 'fix' && c.data.baseRef === 'main',
    ), 'bulk link updateMany called with PR state');

    // Conditional task transition sets submittedById to linkedById and submittedAt; does not null review fields.
    const taskCall = captured.taskUpdateMany[0];
    assert.deepStrictEqual(taskCall.where, { id: 'task-1', status: { in: ['IN_PROGRESS', 'CHANGES_REQUESTED'] } });
    assert.strictEqual(taskCall.data.status, 'SUBMITTED');
    assert.strictEqual(taskCall.data.submittedById, 'user-linker-1');
    assert.ok(taskCall.data.submittedAt instanceof Date);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(taskCall.data, 'submissionSummary'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(taskCall.data, 'reviewFeedback'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(taskCall.data, 'reviewedAt'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(taskCall.data, 'reviewedById'), false);

    // Audit event: workspace id, no actor, source + submittedVia + delivery context.
    const audit = captured.auditCreates.find((a: any) => a.data.action === 'task.github_pr_merged');
    assert.ok(audit, 'task.github_pr_merged audit event recorded');
    assert.strictEqual(audit.data.workspaceId, 'ws-1');
    assert.strictEqual(audit.data.actorId, undefined);
    assert.strictEqual(audit.data.metadata.source, 'GITHUB_WEBHOOK');
    assert.strictEqual(audit.data.metadata.submittedVia, 'GITHUB_MERGE');
    assert.strictEqual(audit.data.metadata.deliveryId, 'deliv-merge-1');
    assert.strictEqual(audit.data.metadata.event, 'pull_request');
    assert.strictEqual(audit.data.metadata.prNumber, 12);
    assert.strictEqual(audit.data.metadata.repositoryFullName, 'owner/repo');
    assert.strictEqual(audit.data.metadata.fromStatus, 'CHANGES_REQUESTED');
    assert.strictEqual(audit.data.metadata.toStatus, 'SUBMITTED');
    assert.strictEqual(audit.data.metadata.linkId, 'link-1');
    assert.strictEqual(audit.data.metadata.externalId, '101');
  });

  test('merged PR does not move an ASSIGNED task and records no audit', async () => {
    const links = [{
      id: 'link-3', taskId: 'task-3', externalId: '103', linkedById: 'linker-3',
      task: { id: 'task-3', status: 'ASSIGNED', key: 'T-3', projectId: 'proj-1', project: { workspaceId: 'ws-1' } },
    }];
    const { prisma, captured } = buildPrisma({ links });
    const out = await invoke(prisma, 103, 14, 'deliv-merge-3');
    assert.strictEqual(out, 'processed');
    // Conditional update attempted but matches no row (ASSIGNED not allowed).
    assert.strictEqual(captured.taskUpdateMany.length, 1);
    assert.deepStrictEqual(captured.taskUpdateMany[0].where, { id: 'task-3', status: { in: ['IN_PROGRESS', 'CHANGES_REQUESTED'] } });
    assert.strictEqual(captured.auditCreates.length, 0, 'no audit when no status transition');
  });

  test('concurrent-style double merge produces exactly one transition and one audit event', async () => {
    const links = [{
      id: 'link-4', taskId: 'task-4', externalId: '104', linkedById: 'linker-4',
      task: { id: 'task-4', status: 'IN_PROGRESS', key: 'T-4', projectId: 'proj-1', project: { workspaceId: 'ws-1' } },
    }];
    const { prisma, captured } = buildPrisma({ links, taskStatuses: new Map([['task-4', 'IN_PROGRESS']]) });
    const body = payload(mergedPr(104, 15));
    const signature = sign(body);
    const p1 = processGithubWebhook({ prisma, rawBody: body, signature, secret: SECRET, deliveryId: 'deliv-merge-4a', event: 'pull_request' });
    const p2 = processGithubWebhook({ prisma, rawBody: body, signature, secret: SECRET, deliveryId: 'deliv-merge-4b', event: 'pull_request' });
    const [out1, out2] = await Promise.all([p1, p2]);
    assert.strictEqual(out1, 'processed');
    assert.strictEqual(out2, 'processed');
    assert.strictEqual(captured.taskUpdateMany.length, 2, 'conditional update attempted twice');
    assert.strictEqual(captured.auditCreates.filter((a: any) => a.data.action === 'task.github_pr_merged').length, 1, 'exactly one audit event');
  });

  test('unlinked PR is ignored with no task change', async () => {
    const { prisma, captured } = buildPrisma({ links: [] });
    const out = await invoke(prisma, 999, 99, 'deliv-unlinked');
    assert.strictEqual(out, 'ignored');
    assert.strictEqual(captured.taskUpdateMany.length, 0);
    assert.strictEqual(captured.auditCreates.length, 0);
  });

  test('pull_request_review submitted sets reviewState/reviewerLogin/reviewedAt and audits', async () => {
    const reviewLinks = [{
      id: 'link-r1', taskId: 'task-r1', externalId: '201',
      task: { id: 'task-r1', projectId: 'proj-1', project: { workspaceId: 'ws-1' } },
    }];
    const { prisma, captured } = buildPrisma({ reviewLinks });
    const body = Buffer.from(JSON.stringify({
      action: 'submitted',
      repository: { full_name: 'owner/repo' },
      pull_request: { id: 201, number: 7 },
      review: { user: { login: 'reviewer1' }, state: 'approved', submitted_at: '2026-02-01T10:00:00Z' },
    }));
    const signature = sign(body);
    const out = await processGithubWebhook({ prisma, rawBody: body, signature, secret: SECRET, deliveryId: 'deliv-review-1', event: 'pull_request_review' });
    assert.strictEqual(out, 'processed');
    const linkUpdate = captured.linkUpdates.find((u: any) => u.data.reviewState === 'APPROVED');
    assert.ok(linkUpdate, 'TaskDevLink reviewState set to APPROVED');
    assert.strictEqual(linkUpdate.data.reviewerLogin, 'reviewer1');
    assert.ok(linkUpdate.data.reviewedAt instanceof Date);
    const audit = captured.auditCreates.find((a: any) => a.data.action === 'task.github_review_synced');
    assert.ok(audit, 'task.github_review_synced audit recorded');
    assert.strictEqual(audit.data.workspaceId, 'ws-1');
    assert.strictEqual(audit.data.actorId, undefined);
    assert.strictEqual(audit.data.metadata.source, 'GITHUB_WEBHOOK');
    assert.strictEqual(audit.data.metadata.deliveryId, 'deliv-review-1');
    assert.strictEqual(audit.data.metadata.event, 'pull_request_review');
    assert.strictEqual(audit.data.metadata.action, 'submitted');
    assert.strictEqual(audit.data.metadata.prNumber, 7);
    assert.strictEqual(audit.data.metadata.repositoryFullName, 'owner/repo');
    assert.strictEqual(audit.data.metadata.reviewState, 'APPROVED');
    assert.strictEqual(audit.data.metadata.reviewerLogin, 'reviewer1');
    assert.strictEqual(audit.data.metadata.taskId, 'task-r1');
  });

  test('pull_request_review edited updates an existing review', async () => {
    const reviewLinks = [{
      id: 'link-r2', taskId: 'task-r2', externalId: '202',
      task: { id: 'task-r2', projectId: 'proj-1', project: { workspaceId: 'ws-1' } },
    }];
    const { prisma, captured } = buildPrisma({ reviewLinks });
    const makeBody = (state: string, submittedAt: string) => Buffer.from(JSON.stringify({
      action: 'edited',
      repository: { full_name: 'owner/repo' },
      pull_request: { id: 202, number: 8 },
      review: { user: { login: 'reviewer1' }, state, submitted_at: submittedAt },
    }));
    const sig1 = sign(makeBody('CHANGES_REQUESTED', '2026-02-01T10:00:00Z'));
    await processGithubWebhook({ prisma, rawBody: makeBody('CHANGES_REQUESTED', '2026-02-01T10:00:00Z'), signature: sig1, secret: SECRET, deliveryId: 'deliv-review-2a', event: 'pull_request_review' });
    const sig2 = sign(makeBody('APPROVED', '2026-02-02T10:00:00Z'));
    await processGithubWebhook({ prisma, rawBody: makeBody('APPROVED', '2026-02-02T10:00:00Z'), signature: sig2, secret: SECRET, deliveryId: 'deliv-review-2b', event: 'pull_request_review' });
    const last = captured.linkUpdates[captured.linkUpdates.length - 1];
    assert.strictEqual(last.data.reviewState, 'APPROVED');
    assert.strictEqual(last.data.reviewerLogin, 'reviewer1');
  });

  test('pull_request_review dismissed clears reviewState/reviewerLogin/reviewedAt', async () => {
    const reviewLinks = [{
      id: 'link-r3', taskId: 'task-r3', externalId: '203',
      task: { id: 'task-r3', projectId: 'proj-1', project: { workspaceId: 'ws-1' } },
    }];
    const { prisma, captured } = buildPrisma({ reviewLinks });
    const body = Buffer.from(JSON.stringify({
      action: 'dismissed',
      repository: { full_name: 'owner/repo' },
      pull_request: { id: 203, number: 9 },
      review: { user: { login: 'reviewer1' }, state: 'dismissed', submitted_at: '2026-02-03T10:00:00Z' },
    }));
    const signature = sign(body);
    const out = await processGithubWebhook({ prisma, rawBody: body, signature, secret: SECRET, deliveryId: 'deliv-review-3', event: 'pull_request_review' });
    assert.strictEqual(out, 'processed');
    const linkUpdate = captured.linkUpdates[captured.linkUpdates.length - 1];
    assert.strictEqual(linkUpdate.data.reviewState, null);
    assert.strictEqual(linkUpdate.data.reviewerLogin, null);
    assert.strictEqual(linkUpdate.data.reviewedAt, null);
  });

  test('pull_request_review out-of-order is ignored (older submitted_at does not overwrite newer reviewedAt)', async () => {
    const reviewLinks = [{
      id: 'link-r4', taskId: 'task-r4', externalId: '204',
      task: { id: 'task-r4', projectId: 'proj-1', project: { workspaceId: 'ws-1' } },
    }];
    // Simulate an existing newer reviewedAt via findUnique.
    const { prisma, captured } = buildPrisma({ reviewLinks });
    // Force findUnique to return a newer reviewedAt for the single link.
    prisma['$transaction'] = async (fn: any) => {
      const tx = await (async () => {
        // build the same tx shape but with a newer reviewedAt
        return {
          taskDevLink: {
            update: async (args: any) => { captured.linkUpdates.push(args); return {}; },
            findUnique: async () => ({ reviewedAt: new Date('2026-06-01T00:00:00Z') }),
          },
          task: { updateMany: async () => ({ count: 0 }) },
          auditLog: { create: async (args: any) => { captured.auditCreates.push(args); return {}; } },
        };
      })();
      return fn(tx);
    };
    const body = Buffer.from(JSON.stringify({
      action: 'submitted',
      repository: { full_name: 'owner/repo' },
      pull_request: { id: 204, number: 10 },
      review: { user: { login: 'reviewer1' }, state: 'approved', submitted_at: '2026-05-01T10:00:00Z' },
    }));
    const signature = sign(body);
    const out = await processGithubWebhook({ prisma, rawBody: body, signature, secret: SECRET, deliveryId: 'deliv-review-4', event: 'pull_request_review' });
    assert.strictEqual(out, 'processed');
    assert.strictEqual(captured.linkUpdates.length, 0, 'out-of-order review does not update the link');
    assert.strictEqual(captured.auditCreates.length, 0, 'out-of-order review records no audit');
  });

  test('merge transition is informational only: no notification and no BE-2 review mutation', async () => {
    const links = [{
      id: 'link-5', taskId: 'task-5', externalId: '105', linkedById: 'linker-5',
      task: { id: 'task-5', status: 'IN_PROGRESS', key: 'T-5', projectId: 'proj-1', project: { workspaceId: 'ws-1' } },
    }];
    const { prisma, captured } = buildPrisma({ links });
    const out = await invoke(prisma, 105, 16, 'deliv-merge-5');
    assert.strictEqual(out, 'processed');
    // Only status/submittedAt/submittedById are touched on the task; no review/approval fields.
    const taskCall = captured.taskUpdateMany[0];
    assert.strictEqual(taskCall.data.status, 'SUBMITTED');
    assert.strictEqual(taskCall.data.submittedById, 'linker-5');
    for (const field of ['submissionSummary', 'reviewFeedback', 'reviewedAt', 'reviewedById', 'completedAt']) {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(taskCall.data, field), false, `${field} must not be touched by a merge`);
    }
    // No notification/email prisma calls are present in the webhook path (mock has none, success proves it).
    assert.strictEqual(captured.deliveryCreate.length, 1);
    assert.strictEqual(captured.deliveryUpdate.length, 1);
  });
});
