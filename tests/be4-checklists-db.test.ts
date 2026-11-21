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

const DB_FLAG = 'RUN_BE4_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('BE-4 checklist PostgreSQL tests', () =>
    test('skipped — set RUN_BE4_DB_TESTS=true to run', () => {}));
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

type ApiResult<T = unknown> = JsonResponse<T>;

function runTests(rawDbUrl: string): void {
  const tag = `${process.pid}-${Date.now()}`;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  let server: RunningServer;
  let baseUrl: string;
  let owner: TestUser;
  let member: TestUser;
  let otherMember: TestUser;
  let manager: TestUser;
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

  const listUrl = (wsId = workspaceId, pid = projectId) =>
    `${baseUrl}/api/v1/workspaces/${wsId}/projects/${pid}/checklists`;
  const checklistUrl = (id: string, wsId = workspaceId, pid = projectId) =>
    `${listUrl(wsId, pid)}/${id}`;
  const itemsUrl = (checklist: string, wsId = workspaceId, pid = projectId) =>
    `${checklistUrl(checklist, wsId, pid)}/items`;
  const itemUrl = (checklist: string, item: string, wsId = workspaceId, pid = projectId) =>
    `${itemsUrl(checklist, wsId, pid)}/${item}`;

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
    const email = `be4-${suffix}-${tag}@test.example`;
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
          name: `BE4 ${visibility} ${tag}`,
          key: `B4${Date.now().toString(36).toUpperCase()}`.slice(0, 20),
          visibility,
          ownerId: owner.id,
          status: 'ACTIVE',
        },
      });
      return project.id;
    });
  }

  async function createChecklist(
    user = owner,
    title = `Checklist ${Date.now()}`,
    wsId = workspaceId,
    pid = projectId,
  ): Promise<string> {
    const response = await api<{ checklist: { id: string } }>(
      user,
      listUrl(wsId, pid),
      'POST',
      { title },
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return (await data(response)).checklist.id;
  }

  async function createItem(
    checklist: string,
    user = owner,
    text = `Item ${Date.now()}-${Math.random()}`,
  ): Promise<string> {
    const response = await api<{ item: { id: string } }>(
      user,
      itemsUrl(checklist),
      'POST',
      { text },
    );
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return (await data(response)).item.id;
  }

  async function checklistRevision(checklist: string): Promise<number> {
    const response = await api<{ checklist: { revision: number } }>(
      owner,
      checklistUrl(checklist),
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return (await data(response)).checklist.revision;
  }

  async function livePositions(checklist: string): Promise<number[]> {
    const response = await api<{ items: Array<{ position: number }> }>(owner, itemsUrl(checklist));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return (await data(response)).items.map((item) => item.position).sort((a, b) => a - b);
  }

  async function expectRejected(fn: () => Promise<unknown>): Promise<void> {
    let rejected = false;
    try {
      await fn();
    } catch {
      rejected = true;
    }
    assert.equal(rejected, true, 'expected database constraint rejection');
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    getPrismaClient(db.url);
    const config = loadTestConfig({
      RATE_LIMIT_NAMESPACE: `be4-db-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    owner = await register('BE4 Owner', 'owner');
    member = await register('BE4 Member', 'member');
    otherMember = await register('BE4 Other Member', 'othermember');
    manager = await register('BE4 Manager', 'manager');
    viewer = await register('BE4 Viewer', 'viewer');
    outsider = await register('BE4 Outsider', 'outsider');

    workspaceId = await createWorkspace(`BE4 Workspace ${tag}`);
    await addWorkspaceMember(member);
    await addWorkspaceMember(otherMember);
    await addWorkspaceMember(manager);
    await addWorkspaceMember(viewer, workspaceId, 'VIEWER');
    otherWorkspaceId = await createWorkspace(`BE4 Other Workspace ${tag}`);

    projectId = await createProject('WORKSPACE');
    privateProjectId = await createProject('PRIVATE');
    await withDb(async (prisma) => {
      await prisma.projectMembership.createMany({
        data: [
          { projectId, userId: member.id, role: 'MEMBER' },
          { projectId, userId: otherMember.id, role: 'MEMBER' },
          { projectId, userId: manager.id, role: 'PROJECT_MANAGER' },
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
  // Authorization and 403/404 rules
  // -------------------------------------------------------------------------

  test('outsider gets 403; wrong workspace and private project get 404', async () => {
    const checklist = await createChecklist();
    const outsiderRead = await api(outsider, checklistUrl(checklist));
    assert.equal(outsiderRead.status, 403, JSON.stringify(outsiderRead.body));
    assert.equal(outsiderRead.body.error?.code, 'WORKSPACE_ACCESS_DENIED');

    const outsiderWrite = await api(outsider, itemsUrl(checklist), 'POST', { text: 'nope' });
    assert.equal(outsiderWrite.status, 403, JSON.stringify(outsiderWrite.body));

    const wrongWorkspace = await api(owner, checklistUrl(checklist, otherWorkspaceId));
    assert.equal(wrongWorkspace.status, 404, JSON.stringify(wrongWorkspace.body));
    assert.equal(wrongWorkspace.body.error?.code, 'CHECKLIST_NOT_FOUND');

    const privateRead = await api(member, listUrl(workspaceId, privateProjectId));
    assert.equal(privateRead.status, 404, JSON.stringify(privateRead.body));
    assert.equal(privateRead.body.error?.code, 'PROJECT_NOT_FOUND');
  });

  test('viewer gets 403 on every write endpoint', async () => {
    const checklist = await createChecklist();
    const item = await createItem(checklist);
    const feedback = await withDb(async (prisma) =>
      prisma.checklistItemFeedback.create({
        data: { checklistItemId: item, authorId: owner.id, body: 'owner feedback' },
      }),
    );

    const writes: Array<[string, string, unknown?]> = [
      [listUrl(), 'POST', { title: 'viewer create' }],
      [checklistUrl(checklist), 'PATCH', { title: 'viewer update' }],
      [checklistUrl(checklist), 'DELETE'],
      [itemsUrl(checklist), 'POST', { text: 'viewer item' }],
      [itemsUrl(checklist) + '/reorder', 'POST', { itemIds: [item] }],
      [itemUrl(checklist, item), 'PATCH', { text: 'viewer edit' }],
      [itemUrl(checklist, item), 'DELETE'],
      [itemUrl(checklist, item) + '/complete', 'POST'],
      [itemUrl(checklist, item) + '/uncomplete', 'POST'],
      [itemUrl(checklist, item) + '/sign-off', 'POST'],
      [itemUrl(checklist, item) + '/sign-off', 'DELETE'],
      [itemUrl(checklist, item) + '/feedback', 'POST', { body: 'viewer feedback' }],
      [itemUrl(checklist, item) + `/feedback/${feedback.id}`, 'PATCH', { body: 'viewer edit' }],
      [itemUrl(checklist, item) + `/feedback/${feedback.id}`, 'DELETE'],
    ];
    for (const [url, method, body] of writes) {
      const response = await api(viewer, url, method, body);
      assert.equal(response.status, 403, `${method} ${url}: ${JSON.stringify(response.body)}`);
    }
  });

  // -------------------------------------------------------------------------
  // Ordering, concurrency and limits
  // -------------------------------------------------------------------------

  test('concurrent reorders leave dense unique positions', async () => {
    const checklist = await createChecklist();
    const a = await createItem(checklist, owner, 'A');
    const b = await createItem(checklist, owner, 'B');
    const c = await createItem(checklist, owner, 'C');
    const results = await Promise.all([
      api(owner, itemsUrl(checklist) + '/reorder', 'POST', { itemIds: [c, a, b] }),
      api(owner, itemsUrl(checklist) + '/reorder', 'POST', { itemIds: [b, c, a] }),
    ]);
    for (const result of results) {
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    assert.deepEqual(await livePositions(checklist), [0, 1, 2]);
  });

  test('concurrent complete produces one real change and one idempotent 200', async () => {
    const checklist = await createChecklist();
    const item = await createItem(checklist);
    const before = await checklistRevision(checklist);
    const results = await Promise.all([
      api(manager, itemUrl(checklist, item) + '/complete', 'POST'),
      api(owner, itemUrl(checklist, item) + '/complete', 'POST'),
    ]);
    for (const result of results) {
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    const winners = results
      .map((result) => result.body.data as { item: { completedById: string | null } })
      .map((value) => value.item.completedById)
      .filter((id) => id !== null);
    assert.equal(winners.length, 2);
    assert.equal(await checklistRevision(checklist), before + 1);
    const audits = await withDb(async (prisma) =>
      prisma.auditLog.count({
        where: {
          action: 'checklist_item.completed',
          metadata: { path: ['itemId'], equals: item },
        },
      }),
    );
    assert.equal(audits, 1);
  });

  test('revision advances once per real item change, never on no-ops or feedback', async () => {
    const checklist = await createChecklist();
    const item = await createItem(checklist);
    const second = await createItem(checklist);
    let revision = await checklistRevision(checklist);

    const complete = await api(manager, itemUrl(checklist, item) + '/complete', 'POST');
    assert.equal(complete.status, 200, JSON.stringify(complete.body));
    assert.equal(await checklistRevision(checklist), ++revision);

    const completeAgain = await api(manager, itemUrl(checklist, item) + '/complete', 'POST');
    assert.equal(completeAgain.status, 200, JSON.stringify(completeAgain.body));
    assert.equal(await checklistRevision(checklist), revision);

    const edited = await api(owner, itemUrl(checklist, item), 'PATCH', { text: 'edited text' });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(await checklistRevision(checklist), ++revision);

    const noEdit = await api(owner, itemUrl(checklist, item), 'PATCH', { text: 'edited text' });
    assert.equal(noEdit.status, 200, JSON.stringify(noEdit.body));
    assert.equal(await checklistRevision(checklist), revision);

    const signOff = await api(owner, itemUrl(checklist, item) + '/sign-off', 'POST');
    assert.equal(signOff.status, 200, JSON.stringify(signOff.body));
    assert.equal(await checklistRevision(checklist), ++revision);

    const feedback = await api<{ feedback: { id: string } }>(
      owner,
      itemUrl(checklist, item) + '/feedback',
      'POST',
      { body: 'feedback body' },
    );
    assert.equal(feedback.status, 201, JSON.stringify(feedback.body));
    const feedbackId = (await data<{ feedback: { id: string } }>(feedback)).feedback.id;
    assert.equal(await checklistRevision(checklist), revision);

    const feedbackEdit = await api(
      owner,
      itemUrl(checklist, item) + `/feedback/${feedbackId}`,
      'PATCH',
      { body: 'edited feedback' },
    );
    assert.equal(feedbackEdit.status, 200, JSON.stringify(feedbackEdit.body));
    assert.equal(await checklistRevision(checklist), revision);

    const feedbackDelete = await api(
      owner,
      itemUrl(checklist, item) + `/feedback/${feedbackId}`,
      'DELETE',
    );
    assert.equal(feedbackDelete.status, 200, JSON.stringify(feedbackDelete.body));
    assert.equal(await checklistRevision(checklist), revision);

    const removed = await api(manager, itemUrl(checklist, item) + '/sign-off', 'DELETE');
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(await checklistRevision(checklist), ++revision);

    const uncompleted = await api(manager, itemUrl(checklist, item) + '/uncomplete', 'POST');
    assert.equal(uncompleted.status, 200, JSON.stringify(uncompleted.body));
    assert.equal(await checklistRevision(checklist), ++revision);

    const reorder = await api(owner, itemsUrl(checklist) + '/reorder', 'POST', {
      itemIds: [second, item],
    });
    assert.equal(reorder.status, 200, JSON.stringify(reorder.body));
    assert.equal(await checklistRevision(checklist), ++revision);

    const deleted = await api(owner, itemUrl(checklist, second), 'DELETE');
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.equal(await checklistRevision(checklist), ++revision);

    const created = await api(owner, itemsUrl(checklist), 'POST', { text: 'new item' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(await checklistRevision(checklist), ++revision);
  });

  test('reorder rejects missing, extra and duplicate ids with 409', async () => {
    const checklist = await createChecklist();
    const item = await createItem(checklist);
    const other = await createItem(checklist, owner, 'other checklist item');
    const variants = [
      { itemIds: [] },
      { itemIds: [item, '00000000-0000-4000-8000-000000000000'] },
      { itemIds: [item, item] },
    ];
    for (const body of variants) {
      const response = await api(owner, itemsUrl(checklist) + '/reorder', 'POST', body);
      assert.equal(response.status, 409, JSON.stringify(response.body));
      assert.equal(response.body.error?.code, 'CHECKLIST_ITEMS_MISMATCH');
    }
    void other;
  });

  test('a checklist accepts at most 200 live items', async () => {
    const checklist = await createChecklist();
    await withDb(async (prisma) => {
      await prisma.checklistItem.createMany({
        data: Array.from({ length: 200 }, (_, position) => ({
          checklistId: checklist,
          position,
          text: `item-${position}`,
        })),
      });
    });
    const response = await api(owner, itemsUrl(checklist), 'POST', { text: 'one too many' });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.error?.code, 'CHECKLIST_ITEM_LIMIT');
  });

  // -------------------------------------------------------------------------
  // State rules
  // -------------------------------------------------------------------------

  test('sign-off rules: completion required, different signer, removal permissions', async () => {
    const checklist = await createChecklist();
    const item = await createItem(checklist);

    const tooEarly = await api(manager, itemUrl(checklist, item) + '/sign-off', 'POST');
    assert.equal(tooEarly.status, 409, JSON.stringify(tooEarly.body));
    assert.equal(tooEarly.body.error?.code, 'ITEM_NOT_COMPLETED');

    const selfComplete = await api(owner, itemUrl(checklist, item) + '/complete', 'POST');
    assert.equal(selfComplete.status, 200, JSON.stringify(selfComplete.body));
    const selfSign = await api(owner, itemUrl(checklist, item) + '/sign-off', 'POST');
    assert.equal(selfSign.status, 403, JSON.stringify(selfSign.body));
    assert.equal(selfSign.body.error?.code, 'SELF_REVIEW_FORBIDDEN');

    const uncompleted = await api(owner, itemUrl(checklist, item) + '/uncomplete', 'POST');
    assert.equal(uncompleted.status, 200, JSON.stringify(uncompleted.body));
    const managerComplete = await api(manager, itemUrl(checklist, item) + '/complete', 'POST');
    assert.equal(managerComplete.status, 200, JSON.stringify(managerComplete.body));

    const signOff = await api(owner, itemUrl(checklist, item) + '/sign-off', 'POST');
    assert.equal(signOff.status, 200, JSON.stringify(signOff.body));

    const signedUncomplete = await api(manager, itemUrl(checklist, item) + '/uncomplete', 'POST');
    assert.equal(signedUncomplete.status, 409, JSON.stringify(signedUncomplete.body));
    assert.equal(signedUncomplete.body.error?.code, 'ITEM_SIGNED_OFF');

    const otherRemove = await api(member, itemUrl(checklist, item) + '/sign-off', 'DELETE');
    assert.equal(otherRemove.status, 403, JSON.stringify(otherRemove.body));

    const signerRemove = await api<{ item: { completed: boolean } }>(
      owner,
      itemUrl(checklist, item) + '/sign-off',
      'DELETE',
    );
    assert.equal(signerRemove.status, 200, JSON.stringify(signerRemove.body));
    const stillCompleted = await data<{ item: { completed: boolean } }>(signerRemove);
    assert.equal(stillCompleted.item.completed, true);

    await api(owner, itemUrl(checklist, item) + '/sign-off', 'POST');
    const adminRemove = await api(manager, itemUrl(checklist, item) + '/sign-off', 'DELETE');
    assert.equal(adminRemove.status, 200, JSON.stringify(adminRemove.body));
  });

  test('uncomplete is limited to the completer or a manager/admin', async () => {
    const checklist = await createChecklist();
    const item = await createItem(checklist);
    const finished = await api(manager, itemUrl(checklist, item) + '/complete', 'POST');
    assert.equal(finished.status, 200, JSON.stringify(finished.body));

    const other = await api(otherMember, itemUrl(checklist, item) + '/uncomplete', 'POST');
    assert.equal(other.status, 403, JSON.stringify(other.body));
    const completer = await api(manager, itemUrl(checklist, item) + '/uncomplete', 'POST');
    assert.equal(completer.status, 200, JSON.stringify(completer.body));

    await api(manager, itemUrl(checklist, item) + '/complete', 'POST');
    const managerUndo = await api(owner, itemUrl(checklist, item) + '/uncomplete', 'POST');
    assert.equal(managerUndo.status, 200, JSON.stringify(managerUndo.body));
  });

  test('CHECK violations are rejected by PostgreSQL', async () => {
    const checklist = await createChecklist();
    const item = await createItem(checklist);
    await withDb(async (prisma) => {
      await expectRejected(() =>
        prisma.$executeRaw`
          INSERT INTO "ChecklistItem" ("id", "checklistId", "position", "text", "createdAt", "updatedAt")
          VALUES (gen_random_uuid()::text, ${checklist}, -1, 'valid', NOW(), NOW())
        `,
      );
      await expectRejected(() =>
        prisma.$executeRaw`
          INSERT INTO "ChecklistItem" ("id", "checklistId", "position", "text", "createdAt", "updatedAt")
          VALUES (gen_random_uuid()::text, ${checklist}, 99, '', NOW(), NOW())
        `,
      );
      await expectRejected(() =>
        prisma.$executeRaw`
          INSERT INTO "ChecklistItemFeedback" ("id", "checklistItemId", "authorId", "body", "createdAt", "updatedAt")
          VALUES (gen_random_uuid()::text, ${item}, ${owner.id}, repeat('x', 4001), NOW(), NOW())
        `,
      );
      await expectRejected(() =>
        prisma.$executeRaw`
          UPDATE "ChecklistItem"
          SET "signedOffAt" = NOW(), "signedOffById" = ${owner.id}
          WHERE "id" = ${item}
        `,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Soft delete, feedback, pagination and audit
  // -------------------------------------------------------------------------

  test('soft-deleted checklist, item and feedback return 404', async () => {
    const checklist = await createChecklist();
    const item = await createItem(checklist);
    const feedback = await withDb(async (prisma) =>
      prisma.checklistItemFeedback.create({
        data: { checklistItemId: item, authorId: owner.id, body: 'to delete' },
      }),
    );
    const feedbackDelete = await api(
      owner,
      itemUrl(checklist, item) + `/feedback/${feedback.id}`,
      'DELETE',
    );
    assert.equal(feedbackDelete.status, 200, JSON.stringify(feedbackDelete.body));
    const feedbackRead = await api(
      owner,
      itemUrl(checklist, item) + `/feedback/${feedback.id}`,
      'PATCH',
      { body: 'still here?' },
    );
    assert.equal(feedbackRead.status, 404, JSON.stringify(feedbackRead.body));
    assert.equal(feedbackRead.body.error?.code, 'CHECKLIST_ITEM_FEEDBACK_NOT_FOUND');

    const itemDelete = await api(owner, itemUrl(checklist, item), 'DELETE');
    assert.equal(itemDelete.status, 200, JSON.stringify(itemDelete.body));
    const itemRead = await api(owner, itemUrl(checklist, item), 'PATCH', { text: 'still here?' });
    assert.equal(itemRead.status, 404, JSON.stringify(itemRead.body));
    assert.equal(itemRead.body.error?.code, 'CHECKLIST_ITEM_NOT_FOUND');

    const checklistDelete = await api(owner, checklistUrl(checklist), 'DELETE');
    assert.equal(checklistDelete.status, 200, JSON.stringify(checklistDelete.body));
    const checklistRead = await api(owner, checklistUrl(checklist));
    assert.equal(checklistRead.status, 404, JSON.stringify(checklistRead.body));
    assert.equal(checklistRead.body.error?.code, 'CHECKLIST_NOT_FOUND');
  });

  test('feedback author and admin permissions', async () => {
    const checklist = await createChecklist();
    const item = await createItem(checklist);
    const created = await api<{ feedback: { id: string } }>(
      manager,
      itemUrl(checklist, item) + '/feedback',
      'POST',
      { body: 'manager feedback' },
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const feedbackId = (await data<{ feedback: { id: string } }>(created)).feedback.id;

    const otherEdit = await api(
      owner,
      itemUrl(checklist, item) + `/feedback/${feedbackId}`,
      'PATCH',
      { body: 'not allowed' },
    );
    assert.equal(otherEdit.status, 403, JSON.stringify(otherEdit.body));
    assert.equal(otherEdit.body.error?.code, 'FEEDBACK_FORBIDDEN');

    const adminDelete = await api(
      owner,
      itemUrl(checklist, item) + `/feedback/${feedbackId}`,
      'DELETE',
    );
    assert.equal(adminDelete.status, 200, JSON.stringify(adminDelete.body));
  });

  test('checklist list cursor pagination is stable', async () => {
    const paginationProjectId = await createProject('WORKSPACE');
    for (let index = 0; index < 3; index += 1) {
      await createChecklist(owner, `Page ${index} ${tag}`, workspaceId, paginationProjectId);
    }
    const first = await api<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      owner,
      `${listUrl(workspaceId, paginationProjectId)}?limit=2`,
    );
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const pageOne = await data(first);
    assert.equal(pageOne.items.length, 2);
    assert.ok(pageOne.nextCursor);
    const second = await api<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      owner,
      `${listUrl(workspaceId, paginationProjectId)}?limit=2&cursor=${pageOne.nextCursor}`,
    );
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const pageTwo = await data(second);
    const seen = [...pageOne.items, ...pageTwo.items].map((entry) => entry.id);
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(pageTwo.nextCursor, null);
  });

  test('mutations emit checklist audit events and no notifications', async () => {
    const notificationsBefore = await withDb(async (prisma) =>
      prisma.notification.count({ where: { userId: { in: userIds } } }),
    );
    const checklist = await createChecklist();
    const item = await createItem(checklist);
    const done = await api(manager, itemUrl(checklist, item) + '/complete', 'POST');
    assert.equal(done.status, 200, JSON.stringify(done.body));

    const actions = await withDb(async (prisma) =>
      prisma.auditLog.findMany({
        where: {
          actorId: { in: userIds },
          action: { in: ['checklist.created', 'checklist_item.created', 'checklist_item.completed'] },
        },
        select: { action: true },
      }),
    );
    const emitted = new Set(actions.map((entry) => entry.action));
    for (const action of [
      'checklist.created',
      'checklist_item.created',
      'checklist_item.completed',
    ]) {
      assert.equal(emitted.has(action), true, `missing audit action ${action}`);
    }
    const notificationsAfter = await withDb(async (prisma) =>
      prisma.notification.count({ where: { userId: { in: userIds } } }),
    );
    assert.equal(notificationsAfter, notificationsBefore);
  });
}
