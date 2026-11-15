import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { installOutboxEmailSender, resetEmailServices } from '../src/services/email';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { loadTestConfig } from './helpers/test-config';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE4_TASK_WORK_DOCUMENTS_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  test('Phase 4 task work documents PostgreSQL tests skipped — set RUN_PHASE4_TASK_WORK_DOCUMENTS_DB_TESTS=true to run', () => {});
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
  let pm: TestUser;
  let member: TestUser;
  let collaborator: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let workspaceId: string;
  let projectId: string;
  let taskId: string;
  let collabTaskId: string;
  let documentId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });
  const docsUrl = (tId = taskId) =>
    `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks/${tId}/work-documents`;

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `p4a-${suffix}-${tag}@test.example`;
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
    assert.equal(login.status, 200);
    const token = (login.body.data as { accessToken: string }).accessToken;
    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      jar,
    });
    const id = (me.body.data as { user: { id: string } }).user.id;
    userIds.push(id);
    return { id, email, token, jar };
  }

  async function addWorkspaceMember(user: TestUser): Promise<void> {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/members`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ email: user.email, role: 'MEMBER' }),
      jar: pm.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  async function addProjectMember(user: TestUser, role: 'PROJECT_MANAGER' | 'MEMBER' | 'COLLABORATOR' | 'VIEWER') {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/members`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ userId: user.id, role }),
      jar: pm.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  const docPayload = (text = 'Hello') => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = loadTestConfig({
      RATE_LIMIT_NAMESPACE: `phase4-task-work-documents-db-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    installOutboxEmailSender(config);
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    pm = await register('PM', 'pm');
    member = await register('Member', 'member');
    collaborator = await register('Collaborator', 'collab');
    viewer = await register('Viewer', 'viewer');
    outsider = await register('Outsider', 'outsider');

    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ name: `P4A WS ${tag}`, type: 'COMPANY' }),
      jar: pm.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);

    await addWorkspaceMember(member);
    await addWorkspaceMember(collaborator);
    await addWorkspaceMember(viewer);
    await addWorkspaceMember(outsider);

    const projectResponse = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ name: 'Phase 4A Project', key: `P4A${String(tag).slice(-4)}`, visibility: 'WORKSPACE' }),
      jar: pm.jar,
    });
    assert.equal(projectResponse.status, 201, JSON.stringify(projectResponse.body));
    projectId = (projectResponse.body.data as { id: string }).id;

    await addProjectMember(member, 'MEMBER');
    await addProjectMember(collaborator, 'COLLABORATOR');
    await addProjectMember(viewer, 'VIEWER');

    const taskRes = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Doc Task', assigneeIds: [member.id] }),
      jar: pm.jar,
    });
    assert.equal(taskRes.status, 201, JSON.stringify(taskRes.body));
    taskId = (taskRes.body.data as { id: string }).id;

    const collabTaskRes = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/tasks`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Collab Doc Task', assigneeIds: [collaborator.id] }),
      jar: pm.jar,
    });
    assert.equal(collabTaskRes.status, 201, JSON.stringify(collabTaskRes.body));
    collabTaskId = (collabTaskRes.body.data as { id: string }).id;
  });

  after(async () => {
    await server.close();
    await disconnectRedis();
    await resetEmailServices();
    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.prisma.taskDocument.deleteMany({ where: { taskId: { in: [taskId, collabTaskId] } } });
    await db.prisma.task.deleteMany({ where: { projectId } });
    await db.prisma.project.deleteMany({ where: { id: projectId } });
    await db.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
  });

  test('create/list/get: PM can create and edit; viewer can view but cannot create/edit/delete', async () => {
    const created = await jsonRequest(docsUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Spec', content: docPayload('v1') }),
      jar: pm.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    documentId = (created.body.data as { id: string }).id;
    assert.equal((created.body.data as { currentVersion: number }).currentVersion, 1);

    const list = await jsonRequest(docsUrl(), { headers: auth(viewer), jar: viewer.jar });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const items = (list.body.data as { items: Array<{ id: string }> }).items;
    assert.ok(items.some((d) => d.id === documentId));

    const get = await jsonRequest(`${docsUrl()}/${documentId}`, { headers: auth(viewer), jar: viewer.jar });
    assert.equal(get.status, 200, JSON.stringify(get.body));
    assert.equal((get.body.data as { title: string }).title, 'Spec');

    const viewerCreate = await jsonRequest(docsUrl(), {
      method: 'POST',
      headers: auth(viewer),
      body: JSON.stringify({ title: 'Nope', content: docPayload('x') }),
      jar: viewer.jar,
    });
    assert.equal(viewerCreate.status, 403, JSON.stringify(viewerCreate.body));

    const viewerEdit = await jsonRequest(`${docsUrl()}/${documentId}`, {
      method: 'PATCH',
      headers: auth(viewer),
      body: JSON.stringify({ baseVersion: 1, content: docPayload('x'), mode: 'manual' }),
      jar: viewer.jar,
    });
    assert.equal(viewerEdit.status, 403, JSON.stringify(viewerEdit.body));

    const viewerDelete = await jsonRequest(`${docsUrl()}/${documentId}`, {
      method: 'DELETE',
      headers: auth(viewer),
      jar: viewer.jar,
    });
    assert.equal(viewerDelete.status, 403, JSON.stringify(viewerDelete.body));
  });

  test('outsider denied access to task work documents', async () => {
    const res = await jsonRequest(docsUrl(), { headers: auth(outsider), jar: outsider.jar });
    assert.ok([403, 404].includes(res.status), JSON.stringify(res.body));
  });

  test('member (project member) and assigned collaborator can edit; collaborator without assignment cannot access task docs', async () => {
    const memberEdit = await jsonRequest(`${docsUrl()}/${documentId}`, {
      method: 'PATCH',
      headers: auth(member),
      body: JSON.stringify({ baseVersion: 1, content: docPayload('v2-member'), mode: 'manual' }),
      jar: member.jar,
    });
    assert.equal(memberEdit.status, 200, JSON.stringify(memberEdit.body));
    assert.equal((memberEdit.body.data as { currentVersion: number }).currentVersion, 2);

    // collaborator is not assigned to taskId (member is) so cannot view it
    const collabDenied = await jsonRequest(docsUrl(), { headers: auth(collaborator), jar: collaborator.jar });
    assert.ok([403, 404].includes(collabDenied.status), JSON.stringify(collabDenied.body));

    // assigned collaborator can view and edit their own assigned task docs
    const collabCreate = await jsonRequest(docsUrl(collabTaskId), {
      method: 'POST',
      headers: auth(collaborator),
      body: JSON.stringify({ title: 'Collab doc', content: docPayload('c1') }),
      jar: collaborator.jar,
    });
    assert.equal(collabCreate.status, 201, JSON.stringify(collabCreate.body));
    const collabDocId = (collabCreate.body.data as { id: string }).id;
    const collabEdit = await jsonRequest(`${docsUrl(collabTaskId)}/${collabDocId}`, {
      method: 'PATCH',
      headers: auth(collaborator),
      body: JSON.stringify({ baseVersion: 1, content: docPayload('c2'), mode: 'manual' }),
      jar: collaborator.jar,
    });
    assert.equal(collabEdit.status, 200, JSON.stringify(collabEdit.body));
  });

  test('stale baseVersion returns 409 conflict with latest content (never overwrite)', async () => {
    const current = await jsonRequest(`${docsUrl()}/${documentId}`, { headers: auth(pm), jar: pm.jar });
    assert.equal(current.status, 200);
    const curVer = (current.body.data as { currentVersion: number }).currentVersion;

    const stale = await jsonRequest(`${docsUrl()}/${documentId}`, {
      method: 'PATCH',
      headers: auth(pm),
      body: JSON.stringify({ baseVersion: 1, content: docPayload('stale'), mode: 'manual' }),
      jar: pm.jar,
    });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error?.code, 'WORK_DOCUMENT_CONFLICT');
    const details = stale.body.error?.details as { currentVersion: number; latestContent: unknown; document: { id: string } };
    assert.equal(details.currentVersion, curVer);
    assert.ok(details.latestContent);
    assert.equal(details.document.id, documentId);

    const after = await jsonRequest(`${docsUrl()}/${documentId}`, { headers: auth(pm), jar: pm.jar });
    assert.equal((after.body.data as { currentVersion: number }).currentVersion, curVer);
  });

  test('autosave throttles to at most one version per minute per user per document (coalesces)', async () => {
    const beforeRes = await jsonRequest(`${docsUrl()}/${documentId}`, { headers: auth(pm), jar: pm.jar });
    const base = (beforeRes.body.data as { currentVersion: number }).currentVersion;

    // first save within window context: create a fresh version then immediately autosave-coalesce
    const manual = await jsonRequest(`${docsUrl()}/${documentId}`, {
      method: 'PATCH',
      headers: auth(pm),
      body: JSON.stringify({ baseVersion: base, content: docPayload('manual'), mode: 'manual' }),
      jar: pm.jar,
    });
    assert.equal(manual.status, 200, JSON.stringify(manual.body));
    const v1 = (manual.body.data as { currentVersion: number }).currentVersion;

    const autosave = await jsonRequest(`${docsUrl()}/${documentId}`, {
      method: 'PATCH',
      headers: auth(pm),
      body: JSON.stringify({ baseVersion: v1, content: docPayload('autosave-coalesced'), mode: 'autosave' }),
      jar: pm.jar,
    });
    assert.equal(autosave.status, 200, JSON.stringify(autosave.body));
    const autoBody = autosave.body.data as { currentVersion: number; throttled?: boolean };
    assert.equal(autoBody.currentVersion, v1, 'should coalesce into same version within 1 minute');
    assert.equal(autoBody.throttled, true);
  });

  test('version history and restore create new versions and preserve history', async () => {
    const current = await jsonRequest(`${docsUrl()}/${documentId}`, { headers: auth(pm), jar: pm.jar });
    const curVer = (current.body.data as { currentVersion: number }).currentVersion;

    const versions = await jsonRequest(`${docsUrl()}/${documentId}/versions`, { headers: auth(pm), jar: pm.jar });
    assert.equal(versions.status, 200, JSON.stringify(versions.body));
    const vItems = (versions.body.data as { items: Array<{ version: number }> }).items;
    assert.ok(vItems.length >= 2);

    const v1 = await jsonRequest(`${docsUrl()}/${documentId}/versions/1`, { headers: auth(pm), jar: pm.jar });
    assert.equal(v1.status, 200, JSON.stringify(v1.body));
    assert.equal((v1.body.data as { version: number }).version, 1);

    const restore = await jsonRequest(`${docsUrl()}/${documentId}/versions/1/restore`, {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({}),
      jar: pm.jar,
    });
    assert.equal(restore.status, 200, JSON.stringify(restore.body));
    const restored = restore.body.data as { currentVersion: number };
    assert.ok(restored.currentVersion > curVer);
  });

  test('sanitizes unsafe content and rejects oversized documents', async () => {
    const unsafe = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'safe', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }, { type: 'bold' }] },
          ],
        },
        { type: 'script', content: [{ type: 'text', text: 'bad' }] },
      ],
    };
    const created = await jsonRequest(docsUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Sanitized', content: unsafe }),
      jar: pm.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const saved = (created.body.data as { content: { content: Array<{ content?: Array<{ marks?: unknown[] }> }> } }).content;
    const marks = saved.content[0]?.content?.[0]?.marks ?? [];
    assert.ok(Array.isArray(marks));
    assert.ok(!JSON.stringify(marks).includes('javascript'));
    assert.ok(!JSON.stringify(saved).includes('"script"'));

    const big = 'a'.repeat(2 * 1024 * 1024 + 100);
    const tooLarge = await jsonRequest(docsUrl(), {
      method: 'POST',
      headers: auth(pm),
      body: JSON.stringify({ title: 'Big', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: big }] }] } }),
      jar: pm.jar,
    });
    assert.equal(tooLarge.status, 400, JSON.stringify(tooLarge.body));
    assert.equal(tooLarge.body.error?.code, 'DOCUMENT_TOO_LARGE');
  });

  test('delete requires task.update (permission-controlled); assignee-only cannot delete', async () => {
    const created = await jsonRequest(docsUrl(), {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ title: 'ToDelete', content: docPayload('d') }),
      jar: member.jar,
    });
    assert.equal(created.status, 201);
    assert.ok((created.body.data as { id: string }).id);

    // member created it but member project role with task.update depends; to test assignee-only cannot delete, use collaborator on assigned task
    const collabCreated = await jsonRequest(docsUrl(collabTaskId), {
      method: 'POST',
      headers: auth(collaborator),
      body: JSON.stringify({ title: 'CollabDel', content: docPayload('d') }),
      jar: collaborator.jar,
    });
    assert.equal(collabCreated.status, 201, JSON.stringify(collabCreated.body));
    const collabDoc = (collabCreated.body.data as { id: string }).id;

    // collaborator is assignee; COLLABORATOR role typically lacks task.update -> delete should be 403
    const collabDelete = await jsonRequest(`${docsUrl(collabTaskId)}/${collabDoc}`, {
      method: 'DELETE',
      headers: auth(collaborator),
      jar: collaborator.jar,
    });
    assert.ok([403].includes(collabDelete.status), JSON.stringify(collabDelete.body));

    const pmDelete = await jsonRequest(`${docsUrl(collabTaskId)}/${collabDoc}`, {
      method: 'DELETE',
      headers: auth(pm),
      jar: pm.jar,
    });
    assert.equal(pmDelete.status, 200, JSON.stringify(pmDelete.body));
  });
}
