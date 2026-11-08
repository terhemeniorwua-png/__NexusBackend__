import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE8_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Calendar project access tests', () =>
    test('skipped — set RUN_PHASE8_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

const S = '2030-01-01T10:00:00.000Z';
const E = '2030-01-01T11:00:00.000Z';

interface TestUser { id: string; email: string; token: string; jar: CookieJar }

function runTests(rawDbUrl: string): void {
  let server: RunningServer;
  let baseUrl: string;
  let owner: TestUser;
  let member: TestUser;
  let workspaceId: string;
  let privateProjectId: string;
  let openProjectId: string;
  let privateEventId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });
  const eventsUrl = () => `${baseUrl}/api/v1/workspaces/${workspaceId}/events`;

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `cp-${suffix}-${tag}@test.example`;
    const password = 'TestPass123!';
    const jar = new CookieJar();
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST', body: JSON.stringify({ name, email, password }), jar,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    const db = await connectTestDatabase(rawDbUrl);
    const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
    await db.prisma.user.update({ where: { id: user.id }, data: { status: 'ACTIVE', emailVerifiedAt: new Date() } });
    await db.prisma.authToken.updateMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', usedAt: null },
      data: { usedAt: new Date() },
    });
    await db.prisma.$disconnect();
    const login = await jsonRequest<{ accessToken: string }>(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST', body: JSON.stringify({ email, password }), jar,
    });
    assert.equal(login.status, 200);
    const token = (login.body.data as { accessToken: string }).accessToken;
    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` }, jar });
    const id = (me.body.data as { user: { id: string } }).user.id;
    userIds.push(id);
    return { id, email, token, jar };
  }

  async function createProject(body: Record<string, unknown>): Promise<string> {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/projects`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify(body), jar: owner.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return (res.body.data as { id: string }).id;
  }

  const createEvent = (user: TestUser, body: Record<string, unknown>) =>
    jsonRequest(eventsUrl(), { method: 'POST', headers: auth(user), body: JSON.stringify(body), jar: user.jar });

  async function listIds(user: TestUser, query = ''): Promise<string[]> {
    const res = await jsonRequest(`${eventsUrl()}${query}`, { headers: auth(user), jar: user.jar });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data as unknown;
    const items = (Array.isArray(d) ? d : (d as { items: { id: string }[] }).items) as { id: string }[];
    return items.map((m) => m.id);
  }

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = (await import('../src/config/env')).loadEnv({
      ...process.env,
      RATE_LIMIT_NAMESPACE: `cal-proj-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    owner = await register('Cal Owner', 'owner');
    member = await register('Cal Member', 'member');
    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify({ name: `Cal Proj ${tag}` }), jar: owner.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);
    const added = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/members`, {
      method: 'POST', headers: auth(owner), body: JSON.stringify({ email: member.email, role: 'MEMBER' }), jar: owner.jar,
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));

    privateProjectId = await createProject({ name: `Secret ${tag}`, key: `S${Date.now()}`, visibility: 'PRIVATE' });
    openProjectId = await createProject({ name: `Open ${tag}`, key: `O${Date.now()}`, visibility: 'WORKSPACE' });

    const m = await createEvent(owner, { title: `Private event ${tag}`, startAt: S, endAt: E, projectId: privateProjectId });
    assert.equal(m.status, 201, JSON.stringify(m.body));
    privateEventId = (m.body.data as { id: string }).id;
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

  test('control: member can create an event with no project', async () => {
    const res = await createEvent(member, { title: 'No project', startAt: S, endAt: E });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  test('control: member can create an event on a WORKSPACE project', async () => {
    const res = await createEvent(member, { title: 'Open project', startAt: S, endAt: E, projectId: openProjectId });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });

  test('control: owner sees the private-project event in list', async () => {
    assert.ok((await listIds(owner)).includes(privateEventId));
  });

  test('member cannot create an event on a PRIVATE project', async () => {
    const res = await createEvent(member, { title: 'Sneaky', startAt: S, endAt: E, projectId: privateProjectId });
    assert.ok([403, 404].includes(res.status), `leaked: expected 403/404, got ${res.status}`);
  });

  test('member cannot list a PRIVATE project events (unfiltered)', async () => {
    assert.ok(!(await listIds(member)).includes(privateEventId), 'leaked: private event in list');
  });

  test('member cannot list a PRIVATE project events (projectId filter)', async () => {
    const ids = await listIds(member, `?projectId=${privateProjectId}`);
    assert.ok(!ids.includes(privateEventId), 'leaked: private event via projectId filter');
  });

  test('member cannot get a PRIVATE project event by id', async () => {
    const res = await jsonRequest(`${eventsUrl()}/${privateEventId}`, { headers: auth(member), jar: member.jar });
    assert.ok([403, 404].includes(res.status), `leaked: expected 403/404, got ${res.status}`);
  });

  const blockedCal = (res: { status: number }, what: string) =>
    assert.ok([403, 404].includes(res.status), `leaked: ${what} expected 403/404, got ${res.status}`);

  test('member cannot PATCH a PRIVATE project event', async () => {
    const res = await jsonRequest(`${eventsUrl()}/${privateEventId}`, { method: 'PATCH', headers: auth(member), body: JSON.stringify({ title: 'hacked' }), jar: member.jar });
    blockedCal(res, 'patch');
  });

  test('member cannot cancel a PRIVATE project event', async () => {
    const res = await jsonRequest(`${eventsUrl()}/${privateEventId}/cancel`, { method: 'POST', headers: auth(member), jar: member.jar });
    blockedCal(res, 'cancel');
  });

  test('member cannot delete a PRIVATE project event', async () => {
    const res = await jsonRequest(`${eventsUrl()}/${privateEventId}`, { method: 'DELETE', headers: auth(member), jar: member.jar });
    blockedCal(res, 'delete');
  });

  test('member cannot list invitations of a PRIVATE project event', async () => {
    const res = await jsonRequest(`${eventsUrl()}/${privateEventId}/invitations`, { headers: auth(member), jar: member.jar });
    blockedCal(res, 'listInvitations');
  });

  test('member cannot add an invitee to a PRIVATE project event', async () => {
    const res = await jsonRequest(`${eventsUrl()}/${privateEventId}/invitations`, { method: 'POST', headers: auth(member), body: JSON.stringify({ userId: owner.id }), jar: member.jar });
    blockedCal(res, 'addInvitee');
  });

  test('member cannot remove an invitee from a PRIVATE project event', async () => {
    const res = await jsonRequest(`${eventsUrl()}/${privateEventId}/invitations/${owner.id}`, { method: 'DELETE', headers: auth(member), jar: member.jar });
    blockedCal(res, 'removeInvitee');
  });

  test('blocked member writes changed nothing (owner view)', async () => {
    const res = await jsonRequest(`${eventsUrl()}/${privateEventId}`, { headers: auth(owner), jar: owner.jar });
    assert.equal(res.status, 200, 'event must still exist');
    const text = JSON.stringify(res.body);
    assert.ok(!text.includes('hacked'), 'title was modified by blocked member');
    assert.ok(!text.includes('CANCELLED'), 'event was cancelled by blocked member');
  });

  test('control: owner can still PATCH the PRIVATE project event', async () => {
    const res = await jsonRequest(`${eventsUrl()}/${privateEventId}`, { method: 'PATCH', headers: auth(owner), body: JSON.stringify({ title: 'owner-edit' }), jar: owner.jar });
    assert.equal(res.status, 200);
    assert.ok(JSON.stringify(res.body).includes('owner-edit'));
  });

  // ---- creator / admin / bystander permissions (plain events, no project) ----
  const mkEvent = async (user: TestUser, title: string): Promise<string> => {
    const r = await createEvent(user, { title, startAt: S, endAt: E });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return (r.body.data as { id: string }).id;
  };
  const isOk = (res: { status: number }, what: string) =>
    assert.ok(res.status >= 200 && res.status < 300, `${what}: expected 2xx, got ${res.status}`);
  const ownerView = (id: string) =>
    jsonRequest(`${eventsUrl()}/${id}`, { headers: auth(owner), jar: owner.jar });

  test('creator (plain MEMBER) can PATCH their own event', async () => {
    const id = await mkEvent(member, `own-patch ${tag}`);
    const res = await jsonRequest(`${eventsUrl()}/${id}`, { method: 'PATCH', headers: auth(member), body: JSON.stringify({ title: 'member-edit' }), jar: member.jar });
    isOk(res, 'creator patch');
    assert.ok(JSON.stringify(res.body).includes('member-edit'));
  });

  test('creator (plain MEMBER) can cancel their own event', async () => {
    const id = await mkEvent(member, `own-cancel ${tag}`);
    const res = await jsonRequest(`${eventsUrl()}/${id}/cancel`, { method: 'POST', headers: auth(member), jar: member.jar });
    isOk(res, 'creator cancel');
  });

  test('creator (plain MEMBER) can delete their own event', async () => {
    const id = await mkEvent(member, `own-delete ${tag}`);
    const res = await jsonRequest(`${eventsUrl()}/${id}`, { method: 'DELETE', headers: auth(member), jar: member.jar });
    isOk(res, 'creator delete');
  });

  test("member cannot PATCH someone else's event", async () => {
    const id = await mkEvent(owner, `victim-patch ${tag}`);
    const res = await jsonRequest(`${eventsUrl()}/${id}`, { method: 'PATCH', headers: auth(member), body: JSON.stringify({ title: 'hacked2' }), jar: member.jar });
    assert.equal(res.status, 403, `leaked: expected 403, got ${res.status}`);
    const view = await ownerView(id);
    assert.equal(view.status, 200);
    assert.ok(!JSON.stringify(view.body).includes('hacked2'), 'title changed by non-creator');
  });

  test("member cannot cancel someone else's event", async () => {
    const id = await mkEvent(owner, `victim-cancel ${tag}`);
    const res = await jsonRequest(`${eventsUrl()}/${id}/cancel`, { method: 'POST', headers: auth(member), jar: member.jar });
    assert.equal(res.status, 403, `leaked: expected 403, got ${res.status}`);
    const view = await ownerView(id);
    assert.equal(view.status, 200);
    assert.ok(!JSON.stringify(view.body).includes('CANCELLED'), 'event cancelled by non-creator');
  });

  test("member cannot delete someone else's event", async () => {
    const id = await mkEvent(owner, `victim-delete ${tag}`);
    const res = await jsonRequest(`${eventsUrl()}/${id}`, { method: 'DELETE', headers: auth(member), jar: member.jar });
    assert.equal(res.status, 403, `leaked: expected 403, got ${res.status}`);
    const view = await ownerView(id);
    assert.equal(view.status, 200, 'event deleted by non-creator');
  });

  test("control: owner can cancel a member's event", async () => {
    const id = await mkEvent(member, `admin-cancel ${tag}`);
    const res = await jsonRequest(`${eventsUrl()}/${id}/cancel`, { method: 'POST', headers: auth(owner), jar: owner.jar });
    isOk(res, 'owner cancel');
  });

  test("control: owner can delete a member's event", async () => {
    const id = await mkEvent(member, `admin-delete ${tag}`);
    const res = await jsonRequest(`${eventsUrl()}/${id}`, { method: 'DELETE', headers: auth(owner), jar: owner.jar });
    isOk(res, 'owner delete');
  });

  test('list with startAfter AND startBefore returns only events inside the date-range window', async () => {
    const mk = async (title: string, startAt: string, endAt: string): Promise<string> => {
      const r = await createEvent(owner, { title: `${title} ${tag}`, startAt, endAt });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      return (r.body.data as { id: string }).id;
    };
    const before = await mk('range-before', '2031-03-01T10:00:00.000Z', '2031-03-01T11:00:00.000Z');
    const inside = await mk('range-inside', '2031-03-10T10:00:00.000Z', '2031-03-10T11:00:00.000Z');
    const after = await mk('range-after', '2031-03-20T10:00:00.000Z', '2031-03-20T11:00:00.000Z');
    const q = `?startAfter=${encodeURIComponent('2031-03-05T00:00:00.000Z')}&startBefore=${encodeURIComponent('2031-03-15T00:00:00.000Z')}`;
    const ids = await listIds(owner, q);
    assert.ok(ids.includes(inside), 'event inside the window is missing');
    assert.ok(!ids.includes(before), 'leaked: event before startAfter was returned');
    assert.ok(!ids.includes(after), 'leaked: event after startBefore was returned');
  });

  test('list with only startAfter excludes earlier events', async () => {
    const r1 = await createEvent(owner, { title: `only-after-early ${tag}`, startAt: '2032-03-01T10:00:00.000Z', endAt: '2032-03-01T11:00:00.000Z' });
    const r2 = await createEvent(owner, { title: `only-after-late ${tag}`, startAt: '2032-03-20T10:00:00.000Z', endAt: '2032-03-20T11:00:00.000Z' });
    const early = (r1.body.data as { id: string }).id;
    const late = (r2.body.data as { id: string }).id;
    const ids = await listIds(owner, `?startAfter=${encodeURIComponent('2032-03-10T00:00:00.000Z')}`);
    assert.ok(ids.includes(late), 'late event missing');
    assert.ok(!ids.includes(early), 'leaked: early event returned');
  });
}
