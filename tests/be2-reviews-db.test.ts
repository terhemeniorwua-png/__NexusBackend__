import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { getPrismaClient } from '../src/db/prisma';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { loadTestConfig } from './helpers/test-config';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import {
  CookieJar,
  jsonRequest,
  startServer,
  type JsonResponse,
  type RunningServer,
} from './helpers/test-server';

const DB_FLAG = 'RUN_BE2_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('BE-2 submission review PostgreSQL tests', () =>
    test('skipped — set RUN_BE2_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

interface TestUser {
  id: string;
  email: string;
  password: string;
  token: string;
  jar: CookieJar;
}

interface ReviewView {
  id: string;
  status: string;
  round: number;
  assigneeId: string | null;
  submittedById: string;
  checklistRevision: number | null;
  taskId: string | null;
  artworkUrl: string | null;
  decisions: Array<{ text: string }> | null;
  stale: boolean;
  resource?: { kind: string; id: string; revision?: number };
  lastDecision: { decision: string; round: number; note: string | null } | null;
}

type ApiResult<T = unknown> = JsonResponse<T>;

function runTests(rawDbUrl: string): void {
  const tag = `${process.pid}-${Date.now()}`;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  let server: RunningServer;
  let baseUrl: string;
  let owner: TestUser;
  let submitter: TestUser;
  let reviewer: TestUser;
  let reviewer2: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let privateProjectId: string;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });

  const reviewsUrl = (wsId = workspaceId, pid = projectId) =>
    `${baseUrl}/api/v1/workspaces/${wsId}/projects/${pid}/reviews`;
  const reviewUrl = (id: string, wsId = workspaceId, pid = projectId) =>
    `${reviewsUrl(wsId, pid)}/${id}`;
  const actionUrl = (id: string, action: string, wsId = workspaceId, pid = projectId) =>
    `${reviewUrl(id, wsId, pid)}/${action}`;

  async function api<T = unknown>(
    user: TestUser,
    url: string,
    method = 'GET',
    body?: unknown,
  ): Promise<ApiResult<T>> {
    return jsonRequest<T>(url, {
      method,
      headers: auth(user),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function data<T>(response: ApiResult<T>): Promise<T> {
    assert.ok(response.body.success && response.body.data !== undefined, JSON.stringify(response.body));
    return response.body.data as T;
  }

  async function withDb<T>(fn: (prisma: ReturnType<typeof getPrismaClient>) => Promise<T>) {
    const db = await connectTestDatabase(rawDbUrl);
    try {
      return await fn(db.prisma);
    } finally {
      await db.prisma.$disconnect();
    }
  }

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `be2-${suffix}-${tag}@test.example`;
    const password = 'TestPass123!';
    const jar = new CookieJar();
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
      jar,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    await withDb(async (prisma) => {
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      await prisma.user.update({
        where: { id: user.id },
        data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
      });
      await prisma.authToken.updateMany({
        where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', usedAt: null },
        data: { usedAt: new Date() },
      });
      userIds.push(user.id);
    });
    const login = await jsonRequest<{ accessToken: string }>(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      jar,
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const token = (login.body.data as { accessToken: string }).accessToken;
    return { id: userIds[userIds.length - 1]!, email, password, token, jar };
  }

  async function createWorkspace(name: string): Promise<string> {
    const response = await api<{ id: string }>(owner, `${baseUrl}/api/v1/workspaces`, 'POST', { name });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const id = (await data(response)).id;
    workspaceIds.push(id);
    return id;
  }

  async function addWorkspaceMember(
    user: TestUser,
    targetWorkspaceId = workspaceId,
    role = 'MEMBER',
  ): Promise<void> {
    const response = await api(
      owner,
      `${baseUrl}/api/v1/workspaces/${targetWorkspaceId}/members`,
      'POST',
      { email: user.email, role },
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }

  async function createProject(visibility: 'WORKSPACE' | 'PRIVATE'): Promise<string> {
    return withDb(async (prisma) => {
      const project = await prisma.project.create({
        data: {
          workspaceId,
          name: `BE2 ${visibility} ${tag}`,
          key: `B2${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 100)}`.slice(0, 20),
          visibility,
          ownerId: owner.id,
          status: 'ACTIVE',
        },
      });
      return project.id;
    });
  }

  // -------------------------------------------------------------------------
  // Target fixture helpers (direct DB inserts for speed and determinism)
  // -------------------------------------------------------------------------

  async function createAttachmentVersion(): Promise<string> {
    return withDb(async (prisma) => {
      const suffix = `${tag}-${Math.random().toString(36).slice(2)}`;
      const attachment = await prisma.fileAttachment.create({
        data: {
          workspaceId,
          projectId,
          uploadedById: submitter.id,
          fileName: `review-${suffix}.txt`,
          mimeType: 'text/plain',
          sizeBytes: 16,
          storageKey: `be2/review-${suffix}`,
        },
      });
      const version = await prisma.attachmentVersion.create({
        data: {
          attachmentId: attachment.id,
          versionNumber: 1,
          isCurrent: true,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          storageKey: `be2/review-v1-${suffix}`,
          uploadedById: submitter.id,
        },
      });
      return version.id;
    });
  }

  async function createChecklist(items: Array<{ text: string; completed: boolean }>): Promise<string> {
    return withDb(async (prisma) => {
      const checklist = await prisma.checklist.create({
        data: {
          workspaceId,
          projectId,
          title: `BE2 checklist ${tag}-${Math.random().toString(36).slice(2)}`,
          createdById: submitter.id,
        },
      });
      for (const [index, item] of items.entries()) {
        await prisma.checklistItem.create({
          data: {
            checklistId: checklist.id,
            position: index,
            text: item.text,
            completed: item.completed,
          },
        });
      }
      return checklist.id;
    });
  }

  async function createTask(opts: { projectId?: string; deletedAt?: Date | null } = {}): Promise<string> {
    const pid = opts.projectId ?? projectId;
    return withDb(async (prisma) => {
      const task = await prisma.task.create({
        data: {
          projectId: pid,
          key: `T${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)}`.slice(0, 20),
          title: `BE2 task ${tag}-${Math.random().toString(36).slice(2)}`,
          creatorId: submitter.id,
          ...(opts.deletedAt !== undefined ? { deletedAt: opts.deletedAt } : {}),
        },
      });
      return task.id;
    });
  }

  async function checklistRevision(id: string): Promise<number> {
    return withDb(async (prisma) => {
      const checklist = await prisma.checklist.findUniqueOrThrow({ where: { id } });
      return checklist.revision;
    });
  }

  async function reviewAuditActions(reviewId: string): Promise<string[]> {
    return withDb(async (prisma) =>
      (await prisma.auditLog.findMany({
        where: { targetType: 'Review', targetId: reviewId },
        orderBy: { createdAt: 'asc' },
        select: { action: true },
      })).map((row) => row.action),
    );
  }

  async function createReviewFor(body: Record<string, unknown>, user = submitter) {
    const response = await api<{ review: ReviewView }>(user, reviewsUrl(), 'POST', body);
    return { response, review: response.body.success ? (response.body.data as { review: ReviewView }).review : null };
  }

  // -------------------------------------------------------------------------
  // Setup / teardown
  // -------------------------------------------------------------------------

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    getPrismaClient(db.url);
    const config = loadTestConfig({
      RATE_LIMIT_NAMESPACE: `be2-db-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    owner = await register('BE2 Owner', 'owner');
    submitter = await register('BE2 Submitter', 'submitter');
    reviewer = await register('BE2 Reviewer', 'reviewer');
    reviewer2 = await register('BE2 Reviewer Two', 'reviewer2');
    viewer = await register('BE2 Viewer', 'viewer');
    outsider = await register('BE2 Outsider', 'outsider');

    workspaceId = await createWorkspace(`BE2 Workspace ${tag}`);
    await addWorkspaceMember(submitter);
    await addWorkspaceMember(reviewer);
    await addWorkspaceMember(reviewer2);
    await addWorkspaceMember(viewer, workspaceId, 'VIEWER');
    otherWorkspaceId = await createWorkspace(`BE2 Other Workspace ${tag}`);

    projectId = await createProject('WORKSPACE');
    privateProjectId = await createProject('PRIVATE');
    await withDb(async (prisma) => {
      await prisma.projectMembership.createMany({
        data: [
          { projectId, userId: submitter.id, role: 'MEMBER' },
          { projectId, userId: reviewer.id, role: 'PROJECT_MANAGER' },
          { projectId, userId: reviewer2.id, role: 'PROJECT_MANAGER' },
          { projectId, userId: viewer.id, role: 'VIEWER' },
        ],
      });
    });
  });

  after(async () => {
    await server?.close();
    await disconnectRedis();
    await withDb(async (prisma) => {
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    });
  });

  // -------------------------------------------------------------------------
  // Raw SQL schema constraints
  // -------------------------------------------------------------------------

  test('raw SQL CHECK constraints reject invalid rows', async () => {
    await withDb(async (prisma) => {
      const versionId = await createAttachmentVersion();
      const checklistId = await createChecklist([{ text: 'done', completed: true }]);
      const reviewId = crypto.randomUUID();
      const baseColumns = {
        id: reviewId,
        workspaceId,
        projectId,
        submittedById: submitter.id,
      };

      async function insert(overrides: Record<string, unknown>): Promise<void> {
        const values = { ...baseColumns, ...overrides };
        const columns = Object.keys(values);
        const params = columns.map((key) => values[key]);
        await prisma.$executeRawUnsafe(
          `INSERT INTO "Review" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns
            .map((c, idx) => (c === 'status' ? `$${idx + 1}::"ReviewStatus"` : `$${idx + 1}`))
            .join(', ')})`,
          ...params,
        );
      }

      await assert.rejects(
        insert({
          attachmentVersionId: versionId,
          checklistId,
          checklistRevision: 1,
          status: 'SUBMITTED',
          round: 1,
          submittedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        /Review_exactly_one_target/,
      );

      await assert.rejects(
        insert({
          attachmentVersionId: null,
          checklistId: null,
          checklistRevision: null,
          status: 'SUBMITTED',
          round: 1,
          submittedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        /Review_exactly_one_target/,
      );

      await assert.rejects(
        insert({
          attachmentVersionId: versionId,
          checklistId: null,
          checklistRevision: null,
          status: 'SUBMITTED',
          round: 0,
          submittedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        /Review_round_positive/,
      );

      await assert.rejects(
        insert({
          attachmentVersionId: null,
          checklistId,
          checklistRevision: null,
          status: 'SUBMITTED',
          round: 1,
          submittedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        /Review_checklistRevision_iff_checklist/,
      );

      // Insert a valid row for ReviewDecision constraint tests.
      await insert({
        attachmentVersionId: versionId,
        checklistId: null,
        checklistRevision: null,
        status: 'SUBMITTED',
        round: 1,
        submittedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      async function insertDecision(values: Record<string, unknown>): Promise<void> {
        const columns = Object.keys(values);
        const params = columns.map((key) => values[key]);
        await prisma.$executeRawUnsafe(
          `INSERT INTO "ReviewDecision" (${columns.map((c) => `"${c}"`).join(', ')}) VALUES (${columns
            .map((c, idx) => (c === 'decision' ? `$${idx + 1}::"ReviewDecisionType"` : `$${idx + 1}`))
            .join(', ')})`,
          ...params,
        );
      }

      const decisionBase = {
        id: crypto.randomUUID(),
        reviewId,
        round: 1,
        decidedById: reviewer.id,
        decidedAt: new Date(),
      };
      await assert.rejects(
        insertDecision({ ...decisionBase, decision: 'REJECTED', note: '   ' }),
        /ReviewDecision_note_nonblank/,
      );
      await assert.rejects(
        insertDecision({ ...decisionBase, decision: 'REJECTED', note: null }),
        /ReviewDecision_note_required_for_negative_decisions/,
      );
      await assert.rejects(
        insertDecision({ ...decisionBase, decision: 'APPROVED', note: 'x'.repeat(2001) }),
        /ReviewDecision_note_length/,
      );
    });
  });

  test('partial unique indexes allow one open review and multiple terminal rows', async () => {
    const versionId = await createAttachmentVersion();
    const first = await createReviewFor({ attachmentVersionId: versionId });
    assert.equal(first.response.status, 201, JSON.stringify(first.response.body));

    const second = await createReviewFor({ attachmentVersionId: versionId });
    assert.equal(second.response.status, 409);
    assert.equal(second.response.body.error?.code, 'REVIEW_ALREADY_OPEN');

    // An approved terminal row blocks any new review for the same target.
    const reviewId = first.review!.id;
    const approve = await api(reviewer, actionUrl(reviewId, 'approve'), 'POST', { round: 1 });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));

    const third = await createReviewFor({ attachmentVersionId: versionId });
    assert.equal(third.response.status, 409);
    assert.equal(third.response.body.error?.code, 'REVIEW_ALREADY_APPROVED');
  });

  test('an approved checklist+revision blocks a new review only at that revision', async () => {
    const checklistId = await createChecklist([{ text: 'done', completed: true }]);
    const { review } = await createReviewFor({ checklistId });
    const approve = await api(reviewer, actionUrl(review!.id, 'approve'), 'POST', { round: 1 });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));

    const duplicate = await createReviewFor({ checklistId });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.response.body.error?.code, 'REVIEW_ALREADY_APPROVED');

    await withDb(async (prisma) => {
      await prisma.checklist.update({
        where: { id: checklistId },
        data: { revision: { increment: 1 } },
      });
    });
    const fresh = await createReviewFor({ checklistId });
    assert.equal(fresh.response.status, 201, JSON.stringify(fresh.response.body));
    assert.equal(fresh.review!.checklistRevision, await checklistRevision(checklistId));
  });

  test('partial unique index permits multiple terminal rows for one target', async () => {
    const versionId = await createAttachmentVersion();
    await withDb(async (prisma) => {
      for (const status of ['APPROVED', 'CHANGES_REQUESTED']) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO "Review" ("id", "workspaceId", "projectId", "attachmentVersionId", "status", "round", "submittedById", "submittedAt", "createdAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5::"ReviewStatus", 1, $6, NOW(), NOW(), NOW())`,
          crypto.randomUUID(),
          workspaceId,
          projectId,
          versionId,
          status,
          submitter.id,
        );
      }
    });
    const count = await withDb(async (prisma) =>
      prisma.review.count({ where: { attachmentVersionId: versionId } }),
    );
    assert.equal(count, 2, 'terminal reviews must not collide with the open-only unique index');
  });

  // -------------------------------------------------------------------------
  // Create + checklist readiness
  // -------------------------------------------------------------------------

  test('creates a review from an attachment version with SUBMITTED round 1', async () => {
    const versionId = await createAttachmentVersion();
    const { response, review } = await createReviewFor({ attachmentVersionId: versionId });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(review!.status, 'SUBMITTED');
    assert.equal(review!.round, 1);
    assert.equal(review!.stale, false);
    assert.equal(review!.submittedById, submitter.id);
  });

  test('checklist submission requires at least one live, completed item', async () => {
    const empty = await createChecklist([]);
    const emptyResponse = await createReviewFor({ checklistId: empty });
    assert.equal(emptyResponse.response.status, 409);
    assert.equal(emptyResponse.response.body.error?.code, 'CHECKLIST_NOT_READY');

    const partial = await createChecklist([
      { text: 'done', completed: true },
      { text: 'pending', completed: false },
    ]);
    const partialResponse = await createReviewFor({ checklistId: partial });
    assert.equal(partialResponse.response.status, 409);
    assert.equal(partialResponse.response.body.error?.code, 'CHECKLIST_NOT_READY');

    const ready = await createChecklist([
      { text: 'a', completed: true },
      { text: 'b', completed: true },
    ]);
    const readyResponse = await createReviewFor({ checklistId: ready });
    assert.equal(readyResponse.response.status, 201, JSON.stringify(readyResponse.response.body));
    assert.equal(readyResponse.review!.checklistRevision, await checklistRevision(ready));
  });

  // -------------------------------------------------------------------------
  // Assignment rules
  // -------------------------------------------------------------------------

  test('assignment rejects self-review and assignees without submission.review', async () => {
    const versionId = await createAttachmentVersion();
    const { review } = await createReviewFor({ attachmentVersionId: versionId });

    const self = await api(reviewer, actionUrl(review!.id, 'assign'), 'POST', {
      assigneeId: submitter.id,
    });
    assert.equal(self.status, 403);
    assert.equal(self.body.error?.code, 'SELF_REVIEW_FORBIDDEN');

    const noPermission = await api(reviewer, actionUrl(review!.id, 'assign'), 'POST', {
      assigneeId: viewer.id,
    });
    assert.equal(noPermission.status, 403);
    assert.equal(noPermission.body.error?.code, 'PERMISSION_DENIED');

    const valid = await api(reviewer, actionUrl(review!.id, 'assign'), 'POST', {
      assigneeId: reviewer2.id,
    });
    assert.equal(valid.status, 200, JSON.stringify(valid.body));
    assert.equal((valid.body.data as { review: ReviewView }).review.assigneeId, reviewer2.id);
  });

  // -------------------------------------------------------------------------
  // Round + revision guards
  // -------------------------------------------------------------------------

  test('decision and resubmit reject a stale round', async () => {
    const versionId = await createAttachmentVersion();
    const { review } = await createReviewFor({ attachmentVersionId: versionId });

    const decideStale = await api(reviewer, actionUrl(review!.id, 'approve'), 'POST', { round: 99 });
    assert.equal(decideStale.status, 409);
    assert.equal(decideStale.body.error?.code, 'STALE_ROUND');

    const changes = await api(reviewer, actionUrl(review!.id, 'request-changes'), 'POST', {
      round: 1,
      note: 'Please revise',
    });
    assert.equal(changes.status, 200, JSON.stringify(changes.body));

    const resubmitStale = await api(submitter, actionUrl(review!.id, 'resubmit'), 'POST', { round: 99 });
    assert.equal(resubmitStale.status, 409);
    assert.equal(resubmitStale.body.error?.code, 'STALE_ROUND');
  });

  test('decision and resubmit reject a stale checklist revision', async () => {
    const checklistId = await createChecklist([{ text: 'done', completed: true }]);
    const { review } = await createReviewFor({ checklistId });

    await withDb(async (prisma) => {
      await prisma.checklist.update({ where: { id: checklistId }, data: { revision: { increment: 1 } } });
    });

    const decideStale = await api(reviewer, actionUrl(review!.id, 'approve'), 'POST', { round: 1 });
    assert.equal(decideStale.status, 409);
    assert.equal(decideStale.body.error?.code, 'CHECKLIST_REVISION_STALE');

    // Test stale resubmit directly by making a CHANGES_REQUESTED review then advancing revision.
    const checklist3 = await createChecklist([{ text: 'done', completed: true }]);
    const review3 = await createReviewFor({ checklistId: checklist3 });
    const changes = await api(reviewer, actionUrl(review3.review!.id, 'request-changes'), 'POST', {
      round: 1,
      note: 'revise',
    });
    assert.equal(changes.status, 200, JSON.stringify(changes.body));
    await withDb(async (prisma) => {
      await prisma.checklist.update({ where: { id: checklist3 }, data: { revision: { increment: 1 } } });
    });
    const resubmitStale = await api(submitter, actionUrl(review3.review!.id, 'resubmit'), 'POST', {
      round: 1,
    });
    assert.equal(resubmitStale.status, 409);
    assert.equal(resubmitStale.body.error?.code, 'CHECKLIST_REVISION_STALE');
  });

  test('resubmit requires a ready checklist and does not create a new Review row', async () => {
    const checklistId = await createChecklist([{ text: 'done', completed: true }]);
    const { review } = await createReviewFor({ checklistId });
    const changes = await api(reviewer, actionUrl(review!.id, 'request-changes'), 'POST', {
      round: 1,
      note: 'revise',
    });
    assert.equal(changes.status, 200, JSON.stringify(changes.body));

    // Make an existing item incomplete without advancing the pinned revision.
    await withDb(async (prisma) => {
      const item = await prisma.checklistItem.findFirstOrThrow({ where: { checklistId } });
      await prisma.checklistItem.update({ where: { id: item.id }, data: { completed: false } });
    });
    const notReady = await api(submitter, actionUrl(review!.id, 'resubmit'), 'POST', { round: 1 });
    assert.equal(notReady.status, 409);
    assert.equal(notReady.body.error?.code, 'CHECKLIST_NOT_READY');

    // Restore and resubmit successfully.
    await withDb(async (prisma) => {
      const item = await prisma.checklistItem.findFirstOrThrow({ where: { checklistId } });
      await prisma.checklistItem.update({ where: { id: item.id }, data: { completed: true } });
    });
    const resubmit = await api<{ review: ReviewView }>(submitter, actionUrl(review!.id, 'resubmit'), 'POST', {
      round: 1,
    });
    assert.equal(resubmit.status, 200, JSON.stringify(resubmit.body));
    const updated = (resubmit.body.data as { review: ReviewView }).review;
    assert.equal(updated.round, 2);
    assert.equal(updated.status, 'SUBMITTED');

    const count = await withDb(async (prisma) => prisma.review.count({ where: { checklistId } }));
    assert.equal(count, 1, 'resubmit must not create a new Review row');
  });

  // -------------------------------------------------------------------------
  // Decisions + concurrency
  // -------------------------------------------------------------------------

  test('two concurrent decisions in one round yield one 200 and one 409', async () => {
    const versionId = await createAttachmentVersion();
    const { review } = await createReviewFor({ attachmentVersionId: versionId });
    const results = await Promise.all([
      api(reviewer, actionUrl(review!.id, 'approve'), 'POST', { round: 1 }),
      api(reviewer2, actionUrl(review!.id, 'request-changes'), 'POST', { round: 1, note: 'revise' }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    const decisions = await withDb(async (prisma) =>
      prisma.reviewDecision.count({ where: { reviewId: review!.id, round: 1 } }),
    );
    assert.equal(decisions, 1);
  });

  test('submitter cannot decide their own submission; any other permission holder can', async () => {
    const versionId = await createAttachmentVersion();
    const { review } = await createReviewFor({ attachmentVersionId: versionId });

    const self = await api(submitter, actionUrl(review!.id, 'approve'), 'POST', { round: 1 });
    assert.equal(self.status, 403);
    assert.equal(self.body.error?.code, 'PERMISSION_DENIED');

    const unassigned = await api(reviewer2, actionUrl(review!.id, 'approve'), 'POST', { round: 1 });
    assert.equal(unassigned.status, 200, JSON.stringify(unassigned.body));
  });

  test('direct SUBMITTED to APPROVED is allowed and APPROVED is terminal', async () => {
    const versionId = await createAttachmentVersion();
    const { review } = await createReviewFor({ attachmentVersionId: versionId });
    const approve = await api(reviewer, actionUrl(review!.id, 'approve'), 'POST', { round: 1 });
    assert.equal(approve.status, 200, JSON.stringify(approve.body));

    const laterDecision = await api(reviewer, actionUrl(review!.id, 'reject'), 'POST', {
      round: 1,
      note: 'too late',
    });
    assert.equal(laterDecision.status, 409);
    assert.equal(laterDecision.body.error?.code, 'INVALID_STATUS_TRANSITION');
  });

  test('decision notes are validated for negative decisions and optional for approve', async () => {
    const versionId = await createAttachmentVersion();
    const { review } = await createReviewFor({ attachmentVersionId: versionId });
    const noNote = await api(reviewer, actionUrl(review!.id, 'reject'), 'POST', { round: 1 });
    assert.equal(noNote.status, 400);
    assert.equal(noNote.body.error?.code, 'VALIDATION_ERROR');

    const blank = await api(reviewer, actionUrl(review!.id, 'reject'), 'POST', { round: 1, note: '   ' });
    assert.equal(blank.status, 400);

    const approved = await api(reviewer, actionUrl(review!.id, 'approve'), 'POST', { round: 1 });
    assert.equal(approved.status, 200);
  });

  // -------------------------------------------------------------------------
  // Visibility, pagination and audit/no-notification guarantees
  // -------------------------------------------------------------------------

  test('soft-deleted targets hide their reviews; list excludes them', async () => {
    const checklistId = await createChecklist([{ text: 'done', completed: true }]);
    const { review } = await createReviewFor({ checklistId });
    await withDb(async (prisma) => {
      await prisma.checklist.update({ where: { id: checklistId }, data: { deletedAt: new Date() } });
    });

    const get = await api(submitter, reviewUrl(review!.id));
    assert.equal(get.status, 404);
    assert.equal(get.body.error?.code, 'REVIEW_TARGET_NOT_FOUND');

    const list = await api<{ items: ReviewView[] }>(submitter, reviewsUrl());
    assert.equal(list.status, 200);
    assert.equal((list.body.data as { items: ReviewView[] }).items.some((r) => r.id === review!.id), false);
  });

  test('authorization: viewer cannot write, outsider and wrong workspace are blocked', async () => {
    const versionId = await createAttachmentVersion();
    const { review } = await createReviewFor({ attachmentVersionId: versionId });

    const viewerCreate = await api(viewer, reviewsUrl(), 'POST', { attachmentVersionId: versionId });
    assert.equal(viewerCreate.status, 403);
    const viewerApprove = await api(viewer, actionUrl(review!.id, 'approve'), 'POST', { round: 1 });
    assert.equal(viewerApprove.status, 403);

    const outsiderRead = await api(outsider, reviewUrl(review!.id));
    assert.equal(outsiderRead.status, 403);
    assert.equal(outsiderRead.body.error?.code, 'WORKSPACE_ACCESS_DENIED');

    // owner belongs to both workspaces, so a cross-workspace review id is 404 here.
    const wrongWorkspace = await api(owner, reviewUrl(review!.id, otherWorkspaceId));
    assert.equal(wrongWorkspace.status, 404, JSON.stringify(wrongWorkspace.body));

    const privateProject = await api(submitter, reviewsUrl(workspaceId, privateProjectId));
    assert.equal(privateProject.status, 404);
    assert.equal(privateProject.body.error?.code, 'PROJECT_NOT_FOUND');
  });

  test('list uses cursor pagination', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const versionId = await createAttachmentVersion();
      const created = await createReviewFor({ attachmentVersionId: versionId });
      ids.push(created.review!.id);
    }
    const firstPage = await api<{ items: ReviewView[]; nextCursor: string | null }>(
      submitter,
      `${reviewsUrl()}?limit=2`,
    );
    assert.equal(firstPage.status, 200);
    const firstData = firstPage.body.data as { items: ReviewView[]; nextCursor: string | null };
    assert.equal(firstData.items.length, 2);
    assert.ok(firstData.nextCursor);

    const secondPage = await api<{ items: ReviewView[]; nextCursor: string | null }>(
      submitter,
      `${reviewsUrl()}?limit=2&cursor=${firstData.nextCursor}`,
    );
    assert.equal(secondPage.status, 200);
    const secondData = secondPage.body.data as { items: ReviewView[]; nextCursor: string | null };
    assert.ok(secondData.items.length > 0);
    const firstIds = new Set(firstData.items.map((r) => r.id));
    assert.equal(secondData.items.some((r) => firstIds.has(r.id)), false, 'pages must not overlap');
  });

  test('full lifecycle records review audit actions and expected review notifications for this review', async () => {
    const checklistId = await createChecklist([{ text: 'done', completed: true }]);
    const { review } = await createReviewFor({ checklistId });
    const assigned = await api(reviewer, actionUrl(review!.id, 'assign'), 'POST', {
      assigneeId: reviewer2.id,
    });
    assert.equal(assigned.status, 200);
    const started = await api(reviewer2, actionUrl(review!.id, 'start'), 'POST');
    assert.equal(started.status, 200);
    const changes = await api(reviewer2, actionUrl(review!.id, 'request-changes'), 'POST', {
      round: 1,
      note: 'revise',
    });
    assert.equal(changes.status, 200);
    const resubmit = await api(submitter, actionUrl(review!.id, 'resubmit'), 'POST', { round: 1 });
    assert.equal(resubmit.status, 200);
    const approve = await api(reviewer2, actionUrl(review!.id, 'approve'), 'POST', { round: 2 });
    assert.equal(approve.status, 200);

    assert.deepEqual(await reviewAuditActions(review!.id), [
      'review.created',
      'review.assigned',
      'review.started',
      'review.changes_requested',
      'review.resubmitted',
      'review.approved',
    ]);

    const reviewNotifications = await withDb(async (prisma) => {
      const rows = await prisma.notification.findMany({
        where: { type: { in: ['REVIEW_SUBMITTED', 'REVIEW_ASSIGNED', 'REVIEW_STARTED', 'REVIEW_CHANGES_REQUESTED', 'REVIEW_RESUBMITTED', 'REVIEW_APPROVED'] } },
        select: { type: true, data: true },
      });
      return rows.filter((r) => (r.data as { targetId?: string } | null)?.targetId === review!.id);
    });

    const counts = reviewNotifications.reduce<Record<string, number>>((acc, r) => {
      acc[r.type] = (acc[r.type] ?? 0) + 1;
      return acc;
    }, {});
    assert.deepEqual(counts, {
      REVIEW_SUBMITTED: 3,
      REVIEW_ASSIGNED: 1,
      REVIEW_STARTED: 1,
      REVIEW_CHANGES_REQUESTED: 1,
      REVIEW_RESUBMITTED: 3,
      REVIEW_APPROVED: 1,
    });
    assert.equal(reviewNotifications.length, 10, 'expected 10 review notifications for this review only');

    const dedupeKeys = reviewNotifications.map((r) => (r.data as { dedupeKey?: string } | null)?.dedupeKey).sort();
    assert.deepEqual(dedupeKeys, [
      `review:${review!.id}:approved:2`,
      `review:${review!.id}:assigned:${reviewer2.id}`,
      `review:${review!.id}:changes_requested:1`,
      `review:${review!.id}:resubmitted:2`,
      `review:${review!.id}:resubmitted:2`,
      `review:${review!.id}:resubmitted:2`,
      `review:${review!.id}:started:1`,
      `review:${review!.id}:submitted`,
      `review:${review!.id}:submitted`,
      `review:${review!.id}:submitted`,
    ].sort());

    const decisions = await withDb(async (prisma) =>
      prisma.reviewDecision.findMany({
        where: { reviewId: review!.id },
        orderBy: { round: 'asc' },
      }),
    );
    assert.deepEqual(decisions.map((d) => d.decision), ['CHANGES_REQUESTED', 'APPROVED']);
    assert.deepEqual(decisions.map((d) => d.round), [1, 2]);
  });

  // -------------------------------------------------------------------------
  // Task-target reviews (BE task-reviews)
  // -------------------------------------------------------------------------

  test('task review: target validation, fields, and lifecycle rules', async () => {
    const taskId = await createTask();
    const attachmentVersionId = await createAttachmentVersion();
    const checklistId = await createChecklist([{ text: 'done', completed: true }]);

    // Exactly one target combos
    const none = await api(submitter, reviewsUrl(), 'POST', {});
    assert.equal(none.status, 400);
    const two = await api(submitter, reviewsUrl(), 'POST', { taskId, checklistId });
    assert.equal(two.status, 400);
    const three = await api(submitter, reviewsUrl(), 'POST', {
      taskId, checklistId, attachmentVersionId, artworkUrl: 'https://example.com/a.png',
    });
    assert.equal(three.status, 400);

    // artworkUrl and decisions rejected on non-task targets
    const artOnChecklist = await api(submitter, reviewsUrl(), 'POST', {
      checklistId, artworkUrl: 'https://example.com/a.png',
    });
    assert.equal(artOnChecklist.status, 400);
    const decisionsOnAttachment = await api(submitter, reviewsUrl(), 'POST', {
      attachmentVersionId, decisions: [{ text: 'Check' }],
    });
    assert.equal(decisionsOnAttachment.status, 400);

    // artworkUrl required for task target
    const missingArt = await api(submitter, reviewsUrl(), 'POST', { taskId });
    assert.equal(missingArt.status, 400);

    // invalid artwork URLs
    for (const badUrl of ['javascript:alert(1)', 'data:text/html,x', 'ftp://example.com/a.png', 'not-a-url']) {
      const bad = await api(submitter, reviewsUrl(), 'POST', { taskId, artworkUrl: badUrl });
      assert.equal(bad.status, 400, badUrl);
    }

    // invalid decisions
    const tooMany = await api(submitter, reviewsUrl(), 'POST', {
      taskId,
      artworkUrl: 'https://example.com/a.png',
      decisions: Array.from({ length: 21 }, (_, i) => ({ text: `d${i}` })),
    });
    assert.equal(tooMany.status, 400);
    const blankDecision = await api(submitter, reviewsUrl(), 'POST', {
      taskId,
      artworkUrl: 'https://example.com/a.png',
      decisions: [{ text: '   ' }],
    });
    assert.equal(blankDecision.status, 400);
    const longDecision = await api(submitter, reviewsUrl(), 'POST', {
      taskId,
      artworkUrl: 'https://example.com/a.png',
      decisions: [{ text: 'a'.repeat(501) }],
    });
    assert.equal(longDecision.status, 400);

    // create task review (round-trips artworkUrl and decisions)
    const created = await api<{ review: ReviewView }>(submitter, reviewsUrl(), 'POST', {
      taskId,
      artworkUrl: 'https://example.com/art.png',
      decisions: [{ text: '  Approve hero  ' }, { text: 'Check spacing' }],
      assigneeId: reviewer.id,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const review = (created.body.data as { review: ReviewView }).review;
    assert.equal(review.resource?.kind, 'task');
    assert.equal(review.taskId, taskId);
    assert.equal(review.artworkUrl, 'https://example.com/art.png');
    assert.deepEqual(review.decisions, [{ text: 'Approve hero' }, { text: 'Check spacing' }]);

    // list filter targetKind=task
    const listed = await api<{ items: ReviewView[] }>(submitter, `${reviewsUrl()}?targetKind=task&targetId=${taskId}`);
    assert.equal(listed.status, 200);
    const items = (listed.body.data as { items: ReviewView[] }).items;
    assert.ok(items.some((r) => r.id === review.id));

    // submitter cannot assign themselves nor decide
    const selfAssign = await api(submitter, actionUrl(review.id, 'assign'), 'POST', { assigneeId: submitter.id });
    assert.equal(selfAssign.status, 403);
    const selfApprove = await api(submitter, actionUrl(review.id, 'approve'), 'POST', { round: 1 });
    assert.equal(selfApprove.status, 403);

    // second open review on same task rejected
    const secondOpen = await api(submitter, reviewsUrl(), 'POST', {
      taskId,
      artworkUrl: 'https://example.com/other.png',
    });
    assert.equal(secondOpen.status, 409);

    // PATCH by submitter works in SUBMITTED, UNDER_REVIEW and CHANGES_REQUESTED
    const patchSubmitted = await api<{ review: ReviewView }>(submitter, reviewUrl(review.id), 'PATCH', {
      round: 1,
      artworkUrl: 'https://example.com/art-v2.png',
      decisions: [{ text: 'Updated decision' }],
    });
    assert.equal(patchSubmitted.status, 200, JSON.stringify(patchSubmitted.body));
    assert.equal((patchSubmitted.body.data as { review: ReviewView }).review.artworkUrl, 'https://example.com/art-v2.png');

    // wrong round refused
    const wrongRound = await api(submitter, reviewUrl(review.id), 'PATCH', {
      round: 99,
      artworkUrl: 'https://example.com/nope.png',
    });
    assert.equal(wrongRound.status, 409);

    // non-submitter refused
    const nonSubmitterPatch = await api(reviewer, reviewUrl(review.id), 'PATCH', {
      round: 1,
      artworkUrl: 'https://example.com/nope.png',
    });
    assert.equal(nonSubmitterPatch.status, 403);

    // PATCH refused for non-task target
    const checklistReview = await createReviewFor({ checklistId, assigneeId: reviewer.id });
    assert.equal(checklistReview.response.status, 201);
    const patchChecklist = await api(submitter, reviewUrl(checklistReview.review!.id), 'PATCH', {
      round: 1,
      artworkUrl: 'https://example.com/nope.png',
    });
    assert.equal(patchChecklist.status, 400);

    // move to UNDER_REVIEW then patch
    const start = await api(reviewer, actionUrl(review.id, 'start'), 'POST');
    assert.equal(start.status, 200);
    const patchUnderReview = await api(submitter, reviewUrl(review.id), 'PATCH', {
      round: 1,
      decisions: [{ text: 'Under review update' }],
    });
    assert.equal(patchUnderReview.status, 200);

    // request changes, then patch in CHANGES_REQUESTED and resubmit
    const reqChanges = await api(reviewer, actionUrl(review.id, 'request-changes'), 'POST', {
      round: 1,
      note: 'Please change',
    });
    assert.equal(reqChanges.status, 200);
    const patchChangesRequested = await api(submitter, reviewUrl(review.id), 'PATCH', {
      round: 1,
      artworkUrl: 'https://example.com/art-v3.png',
    });
    assert.equal(patchChangesRequested.status, 200);

    const resubmit = await api<{ review: ReviewView }>(submitter, actionUrl(review.id, 'resubmit'), 'POST', { round: 1 });
    assert.equal(resubmit.status, 200, JSON.stringify(resubmit.body));
    assert.equal((resubmit.body.data as { review: ReviewView }).review.status, 'SUBMITTED');
    assert.equal((resubmit.body.data as { review: ReviewView }).review.round, 2);

    // approve, then PATCH refused when APPROVED
    const start2 = await api(reviewer, actionUrl(review.id, 'start'), 'POST');
    assert.equal(start2.status, 200);
    const approve = await api(reviewer, actionUrl(review.id, 'approve'), 'POST', { round: 2 });
    assert.equal(approve.status, 200);
    const patchApproved = await api(submitter, reviewUrl(review.id), 'PATCH', {
      round: 2,
      artworkUrl: 'https://example.com/approved.png',
    });
    assert.equal(patchApproved.status, 409);

    // new review after APPROVED accepted for a task
    const afterApproved = await api<{ review: ReviewView }>(submitter, reviewsUrl(), 'POST', {
      taskId,
      artworkUrl: 'https://example.com/new-round.png',
    });
    assert.equal(afterApproved.status, 201, JSON.stringify(afterApproved.body));

    // attachment-version approved rule unchanged
    const versionId = await createAttachmentVersion();
    const v1 = await createReviewFor({ attachmentVersionId: versionId, assigneeId: reviewer.id });
    assert.equal(v1.response.status, 201);
    await api(reviewer, actionUrl(v1.review!.id, 'approve'), 'POST', { round: 1 });
    const v2 = await createReviewFor({ attachmentVersionId: versionId });
    assert.equal(v2.response.status, 409);

    // task from another project/workspace and deleted task rejected
    const otherProjectId = await withDb(async (prisma) => {
      const p = await prisma.project.create({
        data: {
          workspaceId: otherWorkspaceId,
          name: `BE2 other ${tag}`,
          key: `BO${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
          visibility: 'WORKSPACE',
          ownerId: owner.id,
          status: 'ACTIVE',
        },
      });
      return p.id;
    });
    const taskOtherWs = await createTask({ projectId: otherProjectId });
    const crossWs = await api(submitter, reviewsUrl(), 'POST', {
      taskId: taskOtherWs,
      artworkUrl: 'https://example.com/x.png',
    });
    assert.equal(crossWs.status, 404);

    const otherProjectSameWs = await withDb(async (prisma) => {
      const p = await prisma.project.create({
        data: {
          workspaceId,
          name: `BE2 other same ${tag}`,
          key: `BS${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
          visibility: 'WORKSPACE',
          ownerId: owner.id,
          status: 'ACTIVE',
        },
      });
      return p.id;
    });
    const taskOtherProject = await createTask({ projectId: otherProjectSameWs });
    const crossProject = await api(submitter, reviewsUrl(), 'POST', {
      taskId: taskOtherProject,
      artworkUrl: 'https://example.com/x.png',
    });
    assert.equal(crossProject.status, 404);

    const deletedTask = await createTask({ deletedAt: new Date() });
    const deleted = await api(submitter, reviewsUrl(), 'POST', {
      taskId: deletedTask,
      artworkUrl: 'https://example.com/x.png',
    });
    assert.equal(deleted.status, 404);

    // review.updated audit event written and no notification created for it
    const updateReviewId = (afterApproved.body.data as { review: ReviewView }).review.id;
    // patch it and confirm review.updated is recorded
    const patchForAudit = await api(submitter, reviewUrl(updateReviewId), 'PATCH', {
      round: 1,
      decisions: [{ text: 'Audit check' }],
    });
    assert.equal(patchForAudit.status, 200);
    const auditsAfter = await reviewAuditActions(updateReviewId);
    assert.ok(auditsAfter.includes('review.updated'));

    const updatedNotifs = await withDb(async (prisma) =>
      prisma.notification.findMany({
        where: {
          userId: { in: [owner.id, submitter.id, reviewer.id, reviewer2.id, viewer.id] },
        },
        select: { data: true },
      }),
    );
    const hasUpdatedNotification = updatedNotifs.some((n) => {
      const data = n.data as { action?: string } | null;
      return data?.action === 'review.updated';
    });
    assert.equal(hasUpdatedNotification, false);
  });
}
