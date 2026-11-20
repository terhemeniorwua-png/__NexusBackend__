import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { loadTestConfig } from './helpers/test-config';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PROJECT_TYPE_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Project type PostgreSQL tests', () =>
    test('skipped — set RUN_PROJECT_TYPE_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

interface TestUser {
  id: string;
  email: string;
  token: string;
  jar: CookieJar;
}

function runTests(rawDbUrl: string): void {
  let server: RunningServer;
  let baseUrl: string;
  let owner: TestUser;
  let manager: TestUser;
  let member: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let workspaceId: string;
  let otherWorkspaceId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });
  const workspaceProjects = (id = workspaceId) => `${baseUrl}/api/v1/workspaces/${id}/projects`;
  const projectUrl = (id: string, wsId = workspaceId) => `${workspaceProjects(wsId)}/${id}`;

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `ptype-${suffix}-${tag}@test.example`;
    const password = 'TestPass123!';
    const jar = new CookieJar();
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
      jar,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const db = await connectTestDatabase(rawDbUrl);
    const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
    await db.prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await db.prisma.authToken.updateMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', usedAt: null },
      data: { usedAt: new Date() },
    });
    await db.prisma.$disconnect();
    const login = await jsonRequest<{ accessToken: string }>(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      jar,
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const token = (login.body.data as { accessToken: string }).accessToken;
    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      jar,
    });
    const id = (me.body.data as { user: { id: string } }).user.id;
    userIds.push(id);
    return { id, email, token, jar };
  }

  async function addWorkspaceMember(
    user: TestUser,
    targetWorkspaceId = workspaceId,
  ): Promise<void> {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${targetWorkspaceId}/members`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ email: user.email, role: 'MEMBER' }),
      jar: owner.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  async function addProjectMember(
    projectId: string,
    user: TestUser,
    role: 'PROJECT_MANAGER' | 'MEMBER' | 'COLLABORATOR' | 'VIEWER',
  ): Promise<void> {
    const res = await jsonRequest(`${projectUrl(projectId)}/members`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ userId: user.id, role }),
      jar: owner.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  async function createProject(user: TestUser, body: Record<string, unknown>, wsId = workspaceId) {
    return jsonRequest(workspaceProjects(wsId), {
      method: 'POST',
      headers: auth(user),
      body: JSON.stringify(body),
      jar: user.jar,
    });
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = loadTestConfig({
      RATE_LIMIT_NAMESPACE: `project-type-db-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    owner = await register('Project Type Owner', 'owner');
    manager = await register('Project Type Manager', 'manager');
    member = await register('Project Type Member', 'member');
    viewer = await register('Project Type Viewer', 'viewer');
    outsider = await register('Project Type Outsider', 'outsider');

    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: `Project Type Workspace ${tag}` }),
      jar: owner.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);

    await addWorkspaceMember(manager);
    await addWorkspaceMember(member);
    await addWorkspaceMember(viewer);
    await addWorkspaceMember(outsider);

    const other = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: `Project Type Other Workspace ${tag}` }),
      jar: owner.jar,
    });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    otherWorkspaceId = (other.body.data as { id: string }).id;
    workspaceIds.push(otherWorkspaceId);
    await addWorkspaceMember(manager, otherWorkspaceId);
  });

  after(async () => {
    await server?.close();
    await disconnectRedis();
    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
  });

  test('project defaults type to GENERAL and returns it in create/list/detail responses', async () => {
    const created = await createProject(owner, {
      name: 'Default Type Project',
      key: `DT${Date.now()}`,
      visibility: 'WORKSPACE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const project = created.body.data as { id: string; type: string };
    assert.equal(project.type, 'GENERAL');

    const detail = await jsonRequest(projectUrl(project.id), { headers: auth(owner) });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal((detail.body.data as { type: string }).type, 'GENERAL');

    const list = await jsonRequest(workspaceProjects(), { headers: auth(owner) });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const items = (list.body.data as { items: Array<{ id: string; type: string }> }).items;
    const listed = items.find((item) => item.id === project.id);
    assert.ok(listed, 'created project should appear in workspace project list');
    assert.equal(listed.type, 'GENERAL');
  });

  test('invalid project type returns 400', async () => {
    const invalidCreate = await createProject(owner, {
      name: 'Invalid Type Create',
      key: `IC${Date.now()}`,
      type: 'NOT_A_REAL_TYPE',
      visibility: 'WORKSPACE',
    });
    assert.equal(invalidCreate.status, 400, JSON.stringify(invalidCreate.body));

    const created = await createProject(owner, {
      name: 'Invalid Type Update Target',
      key: `IU${Date.now()}`,
      visibility: 'WORKSPACE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = (created.body.data as { id: string }).id;

    const invalidUpdate = await jsonRequest(projectUrl(projectId), {
      method: 'PATCH',
      headers: auth(owner),
      body: JSON.stringify({ type: 'NOT_A_REAL_TYPE' }),
      jar: owner.jar,
    });
    assert.equal(invalidUpdate.status, 400, JSON.stringify(invalidUpdate.body));
  });

  test('manager can set project type and it is returned in responses', async () => {
    const created = await createProject(owner, {
      name: 'Manager Type Project',
      key: `MT${Date.now()}`,
      visibility: 'WORKSPACE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = (created.body.data as { id: string }).id;
    await addProjectMember(projectId, manager, 'PROJECT_MANAGER');

    const updated = await jsonRequest(projectUrl(projectId), {
      method: 'PATCH',
      headers: auth(manager),
      body: JSON.stringify({ type: 'ENGINEERING' }),
      jar: manager.jar,
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal((updated.body.data as { type: string }).type, 'ENGINEERING');

    const detail = await jsonRequest(projectUrl(projectId), { headers: auth(manager) });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal((detail.body.data as { type: string }).type, 'ENGINEERING');

    const list = await jsonRequest(workspaceProjects(), { headers: auth(manager) });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const listed = (list.body.data as { items: Array<{ id: string; type: string }> }).items.find(
      (item) => item.id === projectId,
    );
    assert.ok(listed);
    assert.equal(listed.type, 'ENGINEERING');
  });

  test('member and viewer are refused when changing project type', async () => {
    const created = await createProject(owner, {
      name: 'Role Refused Type Project',
      key: `RR${Date.now()}`,
      visibility: 'WORKSPACE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = (created.body.data as { id: string }).id;
    await addProjectMember(projectId, member, 'MEMBER');
    await addProjectMember(projectId, viewer, 'VIEWER');

    const memberUpdate = await jsonRequest(projectUrl(projectId), {
      method: 'PATCH',
      headers: auth(member),
      body: JSON.stringify({ type: 'DESIGN' }),
      jar: member.jar,
    });
    assert.equal(memberUpdate.status, 403, JSON.stringify(memberUpdate.body));

    const viewerUpdate = await jsonRequest(projectUrl(projectId), {
      method: 'PATCH',
      headers: auth(viewer),
      body: JSON.stringify({ type: 'DESIGN' }),
      jar: viewer.jar,
    });
    assert.equal(viewerUpdate.status, 403, JSON.stringify(viewerUpdate.body));

    const detail = await jsonRequest(projectUrl(projectId), { headers: auth(owner) });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal((detail.body.data as { type: string }).type, 'GENERAL');
  });

  test('outsider and wrong-workspace requests are refused when changing project type', async () => {
    const created = await createProject(owner, {
      name: 'Refused Type Project',
      key: `RF${Date.now()}`,
      visibility: 'PRIVATE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = (created.body.data as { id: string }).id;

    const outsiderUpdate = await jsonRequest(projectUrl(projectId), {
      method: 'PATCH',
      headers: auth(outsider),
      body: JSON.stringify({ type: 'OPERATIONS' }),
      jar: outsider.jar,
    });
    assert.equal(outsiderUpdate.status, 404, JSON.stringify(outsiderUpdate.body));

    const wrongWorkspaceUpdate = await jsonRequest(projectUrl(projectId, otherWorkspaceId), {
      method: 'PATCH',
      headers: auth(manager),
      body: JSON.stringify({ type: 'OPERATIONS' }),
      jar: manager.jar,
    });
    assert.equal(wrongWorkspaceUpdate.status, 404, JSON.stringify(wrongWorkspaceUpdate.body));

    const detail = await jsonRequest(projectUrl(projectId), { headers: auth(owner) });
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    assert.equal((detail.body.data as { type: string }).type, 'GENERAL');
  });

  test('private project type is hidden with 404 from workspace members without project membership', async () => {
    const created = await createProject(owner, {
      name: 'Hidden Type Project',
      key: `HT${Date.now()}`,
      visibility: 'PRIVATE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = (created.body.data as { id: string }).id;

    const detail = await jsonRequest(projectUrl(projectId), { headers: auth(member) });
    assert.equal(detail.status, 404, JSON.stringify(detail.body));
    assert.equal(detail.body.error?.code, 'PROJECT_NOT_FOUND', JSON.stringify(detail.body));

    const update = await jsonRequest(projectUrl(projectId), {
      method: 'PATCH',
      headers: auth(member),
      body: JSON.stringify({ type: 'DESIGN' }),
      jar: member.jar,
    });
    assert.equal(update.status, 404, JSON.stringify(update.body));

    const ownerDetail = await jsonRequest(projectUrl(projectId), { headers: auth(owner) });
    assert.equal(ownerDetail.status, 200, JSON.stringify(ownerDetail.body));
    assert.equal((ownerDetail.body.data as { type: string }).type, 'GENERAL');
  });

  test('strict project schemas reject unknown fields and omitted type stays GENERAL', async () => {
    const unknownField = await createProject(owner, {
      name: 'Strict Type Project',
      key: `ST${Date.now()}`,
      visibility: 'WORKSPACE',
      unexpectedField: 'x',
    });
    assert.equal(unknownField.status, 400, JSON.stringify(unknownField.body));

    const created = await createProject(owner, {
      name: 'Backward Compatible Type Project',
      key: `BC${Date.now()}`,
      visibility: 'WORKSPACE',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal((created.body.data as { type: string }).type, 'GENERAL');
  });

  test('project list stays workspace-scoped and includes type', async () => {
    const inWorkspace = await createProject(owner, {
      name: 'Scoped Type Project A',
      key: `SA${Date.now()}`,
      type: 'HR',
      visibility: 'WORKSPACE',
    });
    assert.equal(inWorkspace.status, 201, JSON.stringify(inWorkspace.body));
    const projectAId = (inWorkspace.body.data as { id: string; type: string }).id;
    assert.equal((inWorkspace.body.data as { type: string }).type, 'HR');

    const inOtherWorkspace = await createProject(
      owner,
      {
        name: 'Scoped Type Project B',
        key: `SB${Date.now()}`,
        type: 'MARKETING',
        visibility: 'WORKSPACE',
      },
      otherWorkspaceId,
    );
    assert.equal(inOtherWorkspace.status, 201, JSON.stringify(inOtherWorkspace.body));
    const projectBId = (inOtherWorkspace.body.data as { id: string }).id;

    const listA = await jsonRequest(workspaceProjects(workspaceId), { headers: auth(owner) });
    assert.equal(listA.status, 200, JSON.stringify(listA.body));
    const itemsA = (listA.body.data as { items: Array<{ id: string; type: string }> }).items;
    assert.ok(itemsA.some((item) => item.id === projectAId && item.type === 'HR'));
    assert.equal(
      itemsA.some((item) => item.id === projectBId),
      false,
      'project from another workspace must not appear in this workspace list',
    );

    const listB = await jsonRequest(workspaceProjects(otherWorkspaceId), { headers: auth(owner) });
    assert.equal(listB.status, 200, JSON.stringify(listB.body));
    const itemsB = (listB.body.data as { items: Array<{ id: string; type: string }> }).items;
    assert.ok(itemsB.some((item) => item.id === projectBId && item.type === 'MARKETING'));
    assert.equal(
      itemsB.some((item) => item.id === projectAId),
      false,
      'project from workspace A must not appear in workspace B list',
    );
  });
}
