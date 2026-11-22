import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import test, { after, before, describe } from 'node:test';
import type { NotificationType, PrismaClient, ProjectRole, TaskStatus, WorkspaceRole } from '@prisma/client';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { processGithubWebhook } from '../src/modules/dev-integrations/github-webhook.service';
import type { AppConfig } from '../src/config/env';
import { loadTestConfig } from './helpers/test-config';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_BE5B_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('BE-5b GitHub notification DB tests', () =>
    test('skipped — set RUN_BE5B_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

const SECRET = 'be5b-webhook-test-secret';

function sign(body: Buffer): string {
  return 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
}

function runTests(rawDbUrl: string): void {
  let prisma: PrismaClient;
  let server: RunningServer;
  let config: AppConfig;

  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const projectIds: string[] = [];
  const taskIds: string[] = [];
  const linkIds: string[] = [];
  const suffix = `${process.pid}-${Date.now()}`;

  async function createUser(label: string) {
    const user = await prisma.user.create({
      data: {
        email: `be5b-${label}-${suffix}-${randomUUID().slice(0, 8)}@test.local`,
        name: `BE5B ${label}`,
        passwordHash: 'x',
        emailVerifiedAt: new Date(),
        status: 'ACTIVE',
      },
      select: { id: true, email: true },
    });
    userIds.push(user.id);
    return user;
  }

  async function createWorkspace(ownerId: string, label: string) {
    const ws = await prisma.workspace.create({
      data: {
        name: `BE5B ${label} ${suffix}`,
        slug: `be5b-${label}-${suffix}-${randomUUID().slice(0, 8)}`,
        ownerId,
        type: 'COMPANY',
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    workspaceIds.push(ws.id);
    await prisma.workspaceMembership.create({
      data: { workspaceId: ws.id, userId: ownerId, role: 'OWNER', status: 'ACTIVE' },
    });
    return ws;
  }

  async function addMember(workspaceId: string, userId: string, role: WorkspaceRole = 'MEMBER') {
    await prisma.workspaceMembership.create({
      data: { workspaceId, userId, role, status: 'ACTIVE' },
    });
  }

  async function createProject(workspaceId: string, ownerId: string, label: string) {
    const project = await prisma.project.create({
      data: {
        workspaceId,
        ownerId,
        name: `BE5B ${label}`,
        key: `B5${randomUUID().slice(0, 6).toUpperCase()}`,
        status: 'ACTIVE',
      },
      select: { id: true },
    });
    projectIds.push(project.id);
    await prisma.projectMembership.create({
      data: { projectId: project.id, userId: ownerId, role: 'PROJECT_MANAGER' },
    });
    return project;
  }

  async function addProjectMember(projectId: string, userId: string, role: ProjectRole = 'MEMBER') {
    await prisma.projectMembership.create({
      data: { projectId, userId, role },
    });
  }

  async function createTask(
    projectId: string,
    creatorId: string,
    opts: { status?: TaskStatus; assigneeIds?: string[]; title?: string } = {},
  ) {
    const task = await prisma.task.create({
      data: {
        projectId,
        creatorId,
        key: `T-${randomUUID().slice(0, 8).toUpperCase()}`,
        title: opts.title ?? `BE5B Task ${randomUUID().slice(0, 6)}`,
        status: opts.status ?? 'IN_PROGRESS',
      },
      select: { id: true, title: true, key: true },
    });
    taskIds.push(task.id);
    for (const userId of opts.assigneeIds ?? []) {
      await prisma.taskAssignee.create({ data: { taskId: task.id, userId } });
    }
    return task;
  }

  async function createDevLink(taskId: string, projectId: string, linkedById: string, externalId: string, number = 1) {
    const link = await prisma.taskDevLink.create({
      data: {
        taskId,
        projectId,
        provider: 'GITHUB',
        externalType: 'PULL_REQUEST',
        externalId,
        externalNumber: number,
        title: 'Fix bug',
        url: `https://github.com/owner/repo/pull/${number}`,
        state: 'open',
        linkedById,
      },
      select: { id: true },
    });
    linkIds.push(link.id);
    return link;
  }

  async function invokeMerge(externalId: string, number: number, deliveryId: string) {
    const body = Buffer.from(JSON.stringify({
      repository: { full_name: 'owner/repo' },
      pull_request: {
        id: Number(externalId),
        number,
        title: 'Secret PR title',
        state: 'closed',
        merged: true,
        merged_at: '2026-01-02T00:00:00Z',
        html_url: `https://github.com/owner/repo/pull/${number}`,
        head: { ref: 'fix' },
        base: { ref: 'main' },
      },
    }));
    return processGithubWebhook({
      prisma,
      rawBody: body,
      signature: sign(body),
      secret: SECRET,
      deliveryId,
      event: 'pull_request',
    });
  }

  async function invokeReview(externalId: string, number: number, deliveryId: string, opts: { reviewId?: number; state?: string; action?: string; submittedAt?: string } = {}) {
    const body = Buffer.from(JSON.stringify({
      action: opts.action ?? 'submitted',
      repository: { full_name: 'owner/repo' },
      pull_request: { id: Number(externalId), number, title: 'Secret PR title', html_url: `https://github.com/owner/repo/pull/${number}` },
      review: {
        id: opts.reviewId ?? 9001,
        user: { login: 'reviewer-gh' },
        state: opts.state ?? 'approved',
        submitted_at: opts.submittedAt ?? '2026-02-01T10:00:00Z',
      },
    }));
    return processGithubWebhook({
      prisma,
      rawBody: body,
      signature: sign(body),
      secret: SECRET,
      deliveryId,
      event: 'pull_request_review',
    });
  }

  async function notificationsFor(userId: string, type: NotificationType) {
    return prisma.notification.findMany({
      where: { userId, type },
      orderBy: { createdAt: 'asc' },
    });
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    prisma = db.prisma;
    config = loadTestConfig({
      DATABASE_URL: db.url,
      TEST_DATABASE_URL: db.url,
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test-jwt-access-secret-32-chars-minimum',
      JWT_REFRESH_SECRET: 'test-jwt-refresh-secret-32-chars-min',
    });
    await connectRedis(config);
    const app = createApp({ config });
    server = await startServer(app);
  });

  after(async () => {
    await server?.close().catch(() => undefined);
    await disconnectRedis().catch(() => undefined);
    if (prisma) {
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } }).catch(() => undefined);
      await prisma.gitHubWebhookDelivery.deleteMany({ where: { provider: 'GITHUB', deliveryId: { startsWith: `be5b-${suffix}` } } }).catch(() => undefined);
      await prisma.taskDevLink.deleteMany({ where: { id: { in: linkIds } } }).catch(() => undefined);
      await prisma.taskAssignee.deleteMany({ where: { taskId: { in: taskIds } } }).catch(() => undefined);
      await prisma.task.deleteMany({ where: { id: { in: taskIds } } }).catch(() => undefined);
      await prisma.projectMembership.deleteMany({ where: { projectId: { in: projectIds } } }).catch(() => undefined);
      await prisma.project.deleteMany({ where: { id: { in: projectIds } } }).catch(() => undefined);
      await prisma.workspaceMembership.deleteMany({ where: { workspaceId: { in: workspaceIds } } }).catch(() => undefined);
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
    }
  });

  test('merge transition notifies task creator and current assignees (deduped, project access), metadata only for repo/PR', async () => {
    const owner = await createUser('owner-a');
    const creator = await createUser('creator-a');
    const assignee = await createUser('assignee-a');
    const both = await createUser('both-a'); // creator+assignee dedupe
    const outsider = await createUser('outsider-a');
    const ws = await createWorkspace(owner.id, 'ws-a');
    for (const u of [creator, assignee, both, outsider]) await addMember(ws.id, u.id);
    const project = await createProject(ws.id, owner.id, 'proj-a');
    for (const u of [creator, assignee, both]) await addProjectMember(project.id, u.id, 'MEMBER');
    // outsider is workspace member but NOT project member - should not receive
    await createTask(project.id, creator.id, { status: 'IN_PROGRESS', assigneeIds: [assignee.id, both.id], title: 'Alpha Task' });
    // "both" is both creator and assignee on task2 - dedupe should yield one notification.
    const task2 = await createTask(project.id, both.id, { status: 'IN_PROGRESS', assigneeIds: [assignee.id, both.id], title: 'Beta Task' });
    await createDevLink(task2.id, project.id, owner.id, '5001', 51);

    const out = await invokeMerge('5001', 51, `be5b-${suffix}-merge-a1`);
    assert.equal(out, 'processed');

    // both is creator and assignee - should get exactly one notification
    const bothNotifs = await notificationsFor(both.id, 'GITHUB_PR_MERGED');
    assert.equal(bothNotifs.length, 1);
    const assigneeNotifs = await notificationsFor(assignee.id, 'GITHUB_PR_MERGED');
    assert.equal(assigneeNotifs.length, 1);
    const outsiderNotifs = await notificationsFor(outsider.id, 'GITHUB_PR_MERGED');
    assert.equal(outsiderNotifs.length, 0);

    const n = bothNotifs[0]!;
    assert.match(n.title, /Beta Task/);
    assert.doesNotMatch(n.title, /Secret PR title|owner\/repo/);
    assert.doesNotMatch(n.body ?? '', /Secret PR title|owner\/repo/);
    const data = n.data as Record<string, unknown>;
    assert.equal(data.repositoryFullName, 'owner/repo');
    assert.equal(data.prNumber, 51);
    assert.equal(data.prTitle, 'Secret PR title');
    assert.equal(data.prUrl, 'https://github.com/owner/repo/pull/51');
  });

  test('redelivered merge webhook and merge on already-merged task do not create duplicate notifications', async () => {
    const owner = await createUser('owner-b');
    const creator = await createUser('creator-b');
    const assignee = await createUser('assignee-b');
    const ws = await createWorkspace(owner.id, 'ws-b');
    for (const u of [creator, assignee]) await addMember(ws.id, u.id);
    const project = await createProject(ws.id, owner.id, 'proj-b');
    for (const u of [creator, assignee]) await addProjectMember(project.id, u.id, 'MEMBER');
    const task = await createTask(project.id, creator.id, { status: 'IN_PROGRESS', assigneeIds: [assignee.id], title: 'Gamma Task' });
    await createDevLink(task.id, project.id, owner.id, '5002', 52);

    const first = await invokeMerge('5002', 52, `be5b-${suffix}-merge-b1`);
    assert.equal(first, 'processed');
    const second = await invokeMerge('5002', 52, `be5b-${suffix}-merge-b1`); // same delivery id
    assert.equal(second, 'duplicate');
    const third = await invokeMerge('5002', 52, `be5b-${suffix}-merge-b2`); // different delivery, already transitioned
    assert.equal(third, 'processed');

    const creatorNotifs = await notificationsFor(creator.id, 'GITHUB_PR_MERGED');
    const assigneeNotifs = await notificationsFor(assignee.id, 'GITHUB_PR_MERGED');
    assert.equal(creatorNotifs.length, 1);
    assert.equal(assigneeNotifs.length, 1);
  });

  test('review notification fires only for newly recorded review; stale/out-of-order review does not notify', async () => {
    const owner = await createUser('owner-c');
    const creator = await createUser('creator-c');
    const assignee = await createUser('assignee-c');
    const ws = await createWorkspace(owner.id, 'ws-c');
    for (const u of [creator, assignee]) await addMember(ws.id, u.id);
    const project = await createProject(ws.id, owner.id, 'proj-c');
    for (const u of [creator, assignee]) await addProjectMember(project.id, u.id, 'MEMBER');
    const task = await createTask(project.id, creator.id, { status: 'IN_PROGRESS', assigneeIds: [assignee.id], title: 'Delta Task' });
    await createDevLink(task.id, project.id, owner.id, '5003', 53);

    const first = await invokeReview('5003', 53, `be5b-${suffix}-review-c1`, { reviewId: 7001, state: 'approved', submittedAt: '2026-02-02T10:00:00Z' });
    assert.equal(first, 'processed');
    const stale = await invokeReview('5003', 53, `be5b-${suffix}-review-c2`, { reviewId: 7002, state: 'changes_requested', submittedAt: '2026-02-01T10:00:00Z' });
    assert.equal(stale, 'processed'); // webhook processed but review ignored as out-of-order

    const creatorNotifs = await notificationsFor(creator.id, 'GITHUB_PR_REVIEW_RECEIVED');
    const assigneeNotifs = await notificationsFor(assignee.id, 'GITHUB_PR_REVIEW_RECEIVED');
    assert.equal(creatorNotifs.length, 1);
    assert.equal(assigneeNotifs.length, 1);
    const n = creatorNotifs[0]!;
    assert.match(n.title, /Delta Task/);
    assert.doesNotMatch(n.title, /Secret PR title|owner\/repo/);
    const data = n.data as Record<string, unknown>;
    assert.equal(data.repositoryFullName, 'owner/repo');
    assert.equal(data.prNumber, 53);
  });

  test('notification failure does not fail webhook or mark delivery FAILED', async () => {
    const owner = await createUser('owner-d');
    const creator = await createUser('creator-d');
    const ws = await createWorkspace(owner.id, 'ws-d');
    await addMember(ws.id, creator.id);
    const project = await createProject(ws.id, owner.id, 'proj-d');
    await addProjectMember(project.id, creator.id, 'MEMBER');
    const task = await createTask(project.id, creator.id, { status: 'IN_PROGRESS', assigneeIds: [], title: 'Epsilon Task' });
    await createDevLink(task.id, project.id, owner.id, '5004', 54);

    const original = prisma.workspaceMembership.findMany;
    // @ts-expect-error - intentional test fault injection
    prisma.workspaceMembership.findMany = async () => { throw new Error('simulated fanout failure'); };
    try {
      const out = await invokeMerge('5004', 54, `be5b-${suffix}-merge-d1`);
      assert.equal(out, 'processed');
    } finally {
      prisma.workspaceMembership.findMany = original;
    }

    const delivery = await prisma.gitHubWebhookDelivery.findUnique({
      where: { provider_deliveryId: { provider: 'GITHUB', deliveryId: `be5b-${suffix}-merge-d1` } },
    });
    assert.equal(delivery?.status, 'PROCESSED');
    assert.equal(delivery?.error, null);
    const taskRow = await prisma.task.findUnique({ where: { id: task.id }, select: { status: true } });
    assert.equal(taskRow?.status, 'SUBMITTED');
    const notifs = await notificationsFor(creator.id, 'GITHUB_PR_MERGED');
    assert.equal(notifs.length, 0);
  });

  test('actor exclusion: mapped actor is excluded when event identifies one (GitHub sender not mapped)', async () => {
    // GitHub webhook path sets actorId null (no Nexus mapping). Verify no exclusion.
    const owner = await createUser('owner-e');
    const creator = await createUser('creator-e');
    const ws = await createWorkspace(owner.id, 'ws-e');
    await addMember(ws.id, creator.id);
    const project = await createProject(ws.id, owner.id, 'proj-e');
    await addProjectMember(project.id, creator.id, 'MEMBER');
    const task = await createTask(project.id, creator.id, { status: 'IN_PROGRESS', assigneeIds: [], title: 'Zeta Task' });
    await createDevLink(task.id, project.id, owner.id, '5005', 55);

    const out = await invokeMerge('5005', 55, `be5b-${suffix}-merge-e1`);
    assert.equal(out, 'processed');
    const creatorNotifs = await notificationsFor(creator.id, 'GITHUB_PR_MERGED');
    assert.equal(creatorNotifs.length, 1); // creator notified; no actor mapped so no exclusion

    // Direct fanout call with mapped actor proves exclusion works.
    const { recordFanoutEventBestEffort } = await import('../src/services/notification-fanout');
    await recordFanoutEventBestEffort(prisma, {
      action: 'task.github_pr_merged',
      workspaceId: ws.id,
      projectId: project.id,
      actorId: creator.id, // mapped actor - should be excluded
      targetType: 'Task',
      targetId: task.id,
      dedupeKey: `github_pr_merged:${task.id}:manual-actor-test`,
      context: {
        taskTitle: task.title,
        creatorId: creator.id,
        assigneeIds: [],
      },
    });
    const after = await notificationsFor(creator.id, 'GITHUB_PR_MERGED');
    assert.equal(after.length, 1); // still 1 - actor excluded
  });
}
