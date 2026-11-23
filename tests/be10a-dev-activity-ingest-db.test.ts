/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import { resolveTestDatabaseUrl, connectTestDatabase } from './helpers/test-database';

const DB_FLAG = 'RUN_BE10A_DEV_ACTIVITY_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);
const WEBHOOK_SECRET = 'be10a-webhook-secret';

function sign(rawBody: Buffer, secret = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

function runTests(rawDbUrl: string): void {
  describe('BE-10a GitHub dev activity ingestion (PostgreSQL)', () => {
    let prisma: any;
    let processGithubWebhook: any;
    let resolveDevActivityDeveloper: any;

    const created: {
      userId?: string;
      mappedUserId?: string;
      workspaceId?: string;
      projectId?: string;
      taskId?: string;
      connectionId?: string;
      deliveryIds: string[];
    } = { deliveryIds: [] };

    before(async () => {
      const db = await connectTestDatabase(rawDbUrl);
      prisma = db.prisma;
      ({ processGithubWebhook } = await import('../src/modules/dev-integrations/github-webhook.service'));
      ({ resolveDevActivityDeveloper } = await import('../src/modules/dev-integrations/dev-activity-identity'));

      const user = await prisma.user.create({
        data: { email: `be10a-${Date.now()}@example.test`, passwordHash: 'x', name: 'BE10A User' },
      });
      const mappedUser = await prisma.user.create({
        data: { email: `be10a-mapped-${Date.now()}@example.test`, passwordHash: 'x', name: 'Mapped Dev' },
      });
      const workspace = await prisma.workspace.create({
        data: { name: 'BE10A WS', slug: `be10a-ws-${Date.now()}`, ownerId: user.id },
      });
      await prisma.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: user.id, role: 'OWNER' },
      });
      await prisma.workspaceMembership.create({
        data: { workspaceId: workspace.id, userId: mappedUser.id, role: 'MEMBER' },
      });
      const connection = await prisma.integrationConnection.create({
        data: {
          provider: 'GITHUB',
          workspaceId: workspace.id,
          status: 'ACTIVE',
          externalAccountLogin: 'mappeddev',
          externalAccountId: 'gh-123',
          externalAccountName: 'Mapped Dev',
          encryptedCredentials: 'not-used-by-test',
          createdById: user.id,
        },
      });
      const project = await prisma.project.create({
        data: { workspaceId: workspace.id, name: 'BE10A Project', key: 'B10A', ownerId: user.id },
      });
      const task = await prisma.task.create({
        data: {
          projectId: project.id,
          key: 'B10A-1',
          title: 'BE10A task',
          creatorId: user.id,
          status: 'IN_PROGRESS',
        },
      });

      created.userId = user.id;
      created.mappedUserId = mappedUser.id;
      created.workspaceId = workspace.id;
      created.projectId = project.id;
      created.taskId = task.id;
      created.connectionId = connection.id;
    });

    after(async () => {
      // Best-effort cleanup; fresh DB per CI file makes this defensive.
      await prisma.repositoryReviewEvent.deleteMany({ where: { repositoryFullName: 'acme/repo' } }).catch(() => undefined);
      await prisma.repositoryPullRequestEvent.deleteMany({ where: { repositoryFullName: 'acme/repo' } }).catch(() => undefined);
      await prisma.repositoryCommit.deleteMany({ where: { repositoryFullName: 'acme/repo' } }).catch(() => undefined);
      await prisma.gitHubWebhookDelivery.deleteMany({ where: { deliveryId: { in: created.deliveryIds } } }).catch(() => undefined);
      await prisma.taskDevLink.deleteMany({ where: { taskId: created.taskId } }).catch(() => undefined);
      if (created.taskId) await prisma.task.delete({ where: { id: created.taskId } }).catch(() => undefined);
      if (created.projectId) await prisma.project.delete({ where: { id: created.projectId } }).catch(() => undefined);
      if (created.connectionId) await prisma.integrationConnection.delete({ where: { id: created.connectionId } }).catch(() => undefined);
      if (created.workspaceId) await prisma.workspace.delete({ where: { id: created.workspaceId } }).catch(() => undefined);
      if (created.mappedUserId) await prisma.user.delete({ where: { id: created.mappedUserId } }).catch(() => undefined);
      if (created.userId) await prisma.user.delete({ where: { id: created.userId } }).catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
    });

    async function send(event: string, deliveryId: string, payload: unknown) {
      created.deliveryIds.push(deliveryId);
      const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
      return processGithubWebhook({
        prisma,
        rawBody,
        signature: sign(rawBody),
        secret: WEBHOOK_SECRET,
        deliveryId,
        event,
      });
    }

    test('identity resolver maps only by verified externalAccountLogin', () => {
      const candidates = [
        { userId: created.mappedUserId!, name: 'Mapped Dev', externalAccountLogin: 'mappeddev' },
      ];
      const mapped = resolveDevActivityDeveloper({ providerLogin: 'MappedDev', candidates });
      assert.equal(mapped.type, 'workspace_user');
      assert.equal(mapped.user?.id, created.mappedUserId);
      assert.equal(mapped.user?.name, 'Mapped Dev');
      assert.equal(mapped.providerLogin, 'MappedDev');

      const unmapped = resolveDevActivityDeveloper({ providerLogin: 'someone-else', candidates });
      assert.deepEqual(unmapped, { type: 'unmapped', user: null, providerLogin: 'someone-else', displayName: 'someone-else' });

      const missing = resolveDevActivityDeveloper({ providerLogin: '  ', candidates });
      assert.equal(missing.type, 'unmapped');
      assert.equal(missing.providerLogin, null);

      const ambiguous = resolveDevActivityDeveloper({
        providerLogin: 'dup',
        candidates: [
          { userId: 'u1', name: 'A', externalAccountLogin: 'dup' },
          { userId: 'u2', name: 'B', externalAccountLogin: 'DUP' },
        ],
      });
      assert.equal(ambiguous.type, 'unmapped');
      assert.equal(ambiguous.providerLogin, 'dup');
    });

    test('push ingestion: default branch commits are stored, non-default ignored, duplicates idempotent', async () => {
      const repo = 'acme/repo';
      const pushPayload = {
        ref: 'refs/heads/main',
        after: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        repository: { full_name: repo, default_branch: 'main' },
        commits: [
          {
            id: '1111111111111111111111111111111111111111',
            message: 'feat: one',
            timestamp: '2026-11-23T10:00:00Z',
            url: 'https://github.com/acme/repo/commit/111',
            author: { name: 'Mapped Dev', username: 'mappeddev' },
          },
          {
            id: '2222222222222222222222222222222222222222',
            message: 'fix: two',
            timestamp: '2026-11-23T11:00:00Z',
            url: 'https://github.com/acme/repo/commit/222',
            author: { name: 'Unknown', username: 'unmapped-gh' },
          },
        ],
      };

      const first = await send('push', 'del-be10a-push-1', pushPayload);
      assert.equal(first, 'processed');
      const second = await send('push', 'del-be10a-push-1', pushPayload); // duplicate delivery
      assert.equal(second, 'duplicate');

      const commits = await prisma.repositoryCommit.findMany({
        where: { provider: 'GITHUB', repositoryFullName: repo },
        orderBy: [{ committedAt: 'asc' }, { id: 'asc' }],
      });
      assert.equal(commits.length, 2);
      assert.equal(commits[0].sha, '1111111111111111111111111111111111111111');
      assert.equal(commits[0].authorLogin, 'mappeddev');
      assert.equal(commits[0].isDefaultBranch, true);
      assert.equal(commits[1].authorLogin, 'unmapped-gh');

      // non-default branch ignored
      const nonDefault = await send('push', 'del-be10a-push-nondefault', {
        ...pushPayload,
        ref: 'refs/heads/feature/x',
        after: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        commits: [{ id: '3333333333333333333333333333333333333333', message: 'nope', timestamp: '2026-11-23T12:00:00Z', author: { username: 'x' } }],
      });
      assert.equal(nonDefault, 'ignored');
      const countAfterNonDefault = await prisma.repositoryCommit.count({ where: { repositoryFullName: repo } });
      assert.equal(countAfterNonDefault, 2);
    });

    test('force-push upserts commits present and does not delete existing mirror rows', async () => {
      const repo = 'acme/repo';
      const result = await send('push', 'del-be10a-force-push', {
        ref: 'refs/heads/main',
        forced: true,
        after: 'cccccccccccccccccccccccccccccccccccccccc',
        repository: { full_name: repo, default_branch: 'main' },
        commits: [
          {
            id: '1111111111111111111111111111111111111111', // existing sha
            message: 'feat: one rewritten',
            timestamp: '2026-11-23T10:05:00Z',
            author: { name: 'Mapped Dev', username: 'mappeddev' },
          },
        ],
      });
      assert.equal(result, 'processed');

      const commits = await prisma.repositoryCommit.findMany({
        where: { provider: 'GITHUB', repositoryFullName: repo },
        orderBy: [{ committedAt: 'asc' }, { id: 'asc' }],
      });
      // sha 111 updated, sha 222 still present (no deletion on force-push)
      assert.equal(commits.length, 2);
      const rewritten = commits.find((c: any) => c.sha === '1111111111111111111111111111111111111111');
      assert.ok(rewritten);
      assert.equal(rewritten.message, 'feat: one rewritten');
      assert.ok(commits.some((c: any) => c.sha === '2222222222222222222222222222222222222222'));
    });

    test('truncated push on default branch: no commit rows fabricated, delivery processed', async () => {
      const repo = 'acme/repo';
      const before = await prisma.repositoryCommit.count({ where: { repositoryFullName: repo } });
      const outcome = await send('push', 'del-be10a-truncated', {
        ref: 'refs/heads/main',
        after: 'dddddddddddddddddddddddddddddddddddddddd',
        repository: { full_name: repo, default_branch: 'main' },
        commits: [], // truncated: commits omitted
      });
      assert.equal(outcome, 'processed');
      const after = await prisma.repositoryCommit.count({ where: { repositoryFullName: repo } });
      assert.equal(after, before, 'no commit mirror rows should be fabricated on truncated push');
    });

    test('out-of-order PR events: merged then opened both ingested idempotently', async () => {
      const repo = 'acme/repo';
      const prId = 98765;
      const merged = await send('pull_request', 'del-be10a-pr-merged', {
        action: 'closed',
        repository: { full_name: repo, default_branch: 'main' },
        pull_request: {
          id: prId,
          number: 42,
          title: 'Out of order PR',
          html_url: 'https://github.com/acme/repo/pull/42',
          merged: true,
          merged_at: '2026-11-23T12:00:00Z',
          closed_at: '2026-11-23T12:00:00Z',
          updated_at: '2026-11-23T12:00:00Z',
          user: { login: 'mappeddev' },
        },
      });
      assert.equal(merged, 'processed');

      const opened = await send('pull_request', 'del-be10a-pr-opened', {
        action: 'opened',
        repository: { full_name: repo, default_branch: 'main' },
        pull_request: {
          id: prId,
          number: 42,
          title: 'Out of order PR',
          html_url: 'https://github.com/acme/repo/pull/42',
          merged: false,
          created_at: '2026-11-23T09:00:00Z',
          updated_at: '2026-11-23T09:00:00Z',
          user: { login: 'mappeddev' },
        },
      });
      assert.equal(opened, 'processed');

      const events = await prisma.repositoryPullRequestEvent.findMany({
        where: { provider: 'GITHUB', repositoryFullName: repo, externalPrId: String(prId) },
        orderBy: [{ action: 'asc' }],
      });
      assert.deepEqual(events.map((e: any) => e.action).sort(), ['MERGED', 'OPENED']);
    });

    test('mapped and unmapped commit authors are stored; resolver maps only verified workspace login', async () => {
      const repo = 'acme/repo';
      const commits = await prisma.repositoryCommit.findMany({
        where: { provider: 'GITHUB', repositoryFullName: repo },
      });
      const byLogin = new Map(commits.map((c: any) => [c.authorLogin, c]));
      assert.ok(byLogin.has('mappeddev'));
      assert.ok(byLogin.has('unmapped-gh'));

      const candidates = await prisma.integrationConnection.findMany({
        where: { workspaceId: created.workspaceId, provider: 'GITHUB', status: 'ACTIVE', externalAccountLogin: { not: null } },
        select: {
          createdById: true,
          externalAccountLogin: true,
          createdBy: { select: { id: true, name: true } },
        },
      });
      const resolverCandidates = candidates.map((c: any) => ({
        userId: c.createdBy.id,
        name: c.createdBy.name,
        externalAccountLogin: c.externalAccountLogin,
      }));

      const mapped = resolveDevActivityDeveloper({ providerLogin: 'mappeddev', candidates: resolverCandidates });
      assert.equal(mapped.type, 'workspace_user');
      assert.equal(mapped.user?.id, created.userId); // connection was createdBy user

      const unmapped = resolveDevActivityDeveloper({ providerLogin: 'unmapped-gh', candidates: resolverCandidates });
      assert.equal(unmapped.type, 'unmapped');
      assert.equal(unmapped.providerLogin, 'unmapped-gh');
    });

    test('PR webhook keeps TaskDevLink behavior unchanged and ingests mirror event', async () => {
      const repo = 'acme/repo';
      const prId = 77777;
      const link = await prisma.taskDevLink.create({
        data: {
          taskId: created.taskId!,
          projectId: created.projectId!,
          provider: 'GITHUB',
          externalType: 'PULL_REQUEST',
          externalId: String(prId),
          linkedById: created.userId!,
        },
      });

      const outcome = await send('pull_request', 'del-be10a-pr-link', {
        action: 'opened',
        repository: { full_name: repo, default_branch: 'main' },
        pull_request: {
          id: prId,
          number: 77,
          title: 'Linked PR',
          html_url: 'https://github.com/acme/repo/pull/77',
          state: 'open',
          merged: false,
          created_at: '2026-11-23T08:00:00Z',
          updated_at: '2026-11-23T08:00:00Z',
          user: { login: 'mappeddev' },
          head: { ref: 'feature/x' },
          base: { ref: 'main' },
        },
      });
      assert.equal(outcome, 'processed');

      const updated = await prisma.taskDevLink.findUnique({ where: { id: link.id } });
      assert.ok(updated);
      assert.equal(updated.externalNumber, 77);
      assert.equal(updated.state, 'open');

      const mirror = await prisma.repositoryPullRequestEvent.findUnique({
        where: {
          provider_repositoryFullName_externalPrId_action: {
            provider: 'GITHUB',
            repositoryFullName: repo,
            externalPrId: String(prId),
            action: 'OPENED',
          },
        },
      });
      assert.ok(mirror, 'PR mirror event should be ingested');

      await prisma.taskDevLink.delete({ where: { id: link.id } }).catch(() => undefined);
    });

    test('pull_request_review submitted is ingested (idempotent)', async () => {
      const repo = 'acme/repo';
      const payload = {
        action: 'submitted',
        repository: { full_name: repo, default_branch: 'main' },
        pull_request: { id: 98765, number: 42 },
        review: {
          id: 55555,
          state: 'approved',
          submitted_at: '2026-11-23T13:00:00Z',
          html_url: 'https://github.com/acme/repo/pull/42#pullrequestreview-55555',
          user: { login: 'reviewer1' },
        },
      };
      const first = await send('pull_request_review', 'del-be10a-review-1', payload);
      assert.equal(first, 'processed');
      const dup = await send('pull_request_review', 'del-be10a-review-1', payload);
      assert.equal(dup, 'duplicate');

      const review = await prisma.repositoryReviewEvent.findUnique({
        where: {
          provider_repositoryFullName_externalReviewId: {
            provider: 'GITHUB',
            repositoryFullName: repo,
            externalReviewId: '55555',
          },
        },
      });
      assert.ok(review);
      assert.equal(review.reviewState, 'APPROVED');
      assert.equal(review.reviewerLogin, 'reviewer1');
    });
  });
}

if (!databaseUrl) {
  describe('BE-10a GitHub dev activity ingestion (PostgreSQL)', () =>
    test(`skipped — set ${DB_FLAG}=true to run`, () => {}));
} else {
  runTests(databaseUrl);
}
