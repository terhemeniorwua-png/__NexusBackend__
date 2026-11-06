import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE10_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Phase 10 messaging tests', () =>
    test('skipped — set RUN_PHASE10_DB_TESTS=true to run', () => {}));
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
  let member: TestUser;
  let outsider: TestUser;
  let workspaceId: string;
  let channelId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `p10-${suffix}-${tag}@test.example`;
    const password = 'TestPass123!';
    const jar = new CookieJar();
    await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
      jar,
    });
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
    const token = (login.body.data as { accessToken: string }).accessToken;
    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      jar,
    });
    const id = (me.body.data as { user: { id: string } }).user.id;
    userIds.push(id);
    return { id, email, token, jar };
  }

  const channelUrl = () => `${baseUrl}/api/v1/workspaces/${workspaceId}/channels`;
  const messageUrl = () => `${channelUrl()}/${channelId}/messages`;

  before(async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const { getPrismaClient } = await import('../src/db/prisma');
    getPrismaClient(db.url);
    const config = (await import('../src/config/env')).loadEnv({
      ...process.env,
      RATE_LIMIT_NAMESPACE: `phase10-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    owner = await register('P10 Owner', 'owner');
    member = await register('P10 Member', 'member');
    outsider = await register('P10 Outsider', 'outsider');

    // Create workspace
    const wsRes = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: `P10 WS ${tag}` }),
      jar: owner.jar,
    });
    workspaceId = (wsRes.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);

    // Add member
    await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/members`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ email: member.email, role: 'MEMBER' }),
      jar: owner.jar,
    });

    // Create a workspace channel
    const chRes = await jsonRequest(channelUrl(), {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ type: 'WORKSPACE', name: 'General' }),
      jar: owner.jar,
    });
    channelId = (chRes.body.data as { id: string }).id;
  });

  after(async () => {
    await server.close();
    await disconnectRedis();
    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.message.deleteMany({ where: { channelId } });
    await db.prisma.channel.deleteMany({ where: { workspaceId } });
    await db.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
  });

  describe('Phase 10 messaging', () => {
    test('owner can send a message', async () => {
      const res = await jsonRequest(messageUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ body: 'Hello world' }),
        jar: owner.jar,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal((res.body.data as { body: string }).body, 'Hello world');
      assert.ok((res.body.data as { authorName: string }).authorName);
    });

    test('member can send a message to a workspace channel', async () => {
      const res = await jsonRequest(messageUrl(), {
        method: 'POST',
        headers: auth(member),
        body: JSON.stringify({ body: 'Hi from member' }),
        jar: member.jar,
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    });

    test('outsider cannot send messages', async () => {
      const res = await jsonRequest(messageUrl(), {
        method: 'POST',
        headers: auth(outsider),
        body: JSON.stringify({ body: 'Should fail' }),
        jar: outsider.jar,
      });
      // Non-members get 404 — the channel policy hides existence from
      // unauthorized users for security (no information leak).
      assert.ok(res.status === 404 || res.status === 403, `expected 404 or 403, got ${res.status}`);
    });

    test('can list messages with pagination', async () => {
      // Send a few messages
      for (let i = 0; i < 3; i++) {
        await jsonRequest(messageUrl(), {
          method: 'POST',
          headers: auth(owner),
          body: JSON.stringify({ body: `Message ${i}` }),
          jar: owner.jar,
        });
      }

      const res = await jsonRequest(`${messageUrl()}?limit=2`, {
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(res.status, 200);
      const data = res.body.data as { items: unknown[]; nextCursor: string | null };
      assert.ok(data.items.length <= 2);
      assert.ok(data.nextCursor, 'should have a next cursor for pagination');
    });

    test('can edit own message', async () => {
      const send = await jsonRequest(messageUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ body: 'Edit me' }),
        jar: owner.jar,
      });
      const msgId = (send.body.data as { id: string }).id;

      const res = await jsonRequest(`${messageUrl()}/${msgId}`, {
        method: 'PATCH',
        headers: auth(owner),
        body: JSON.stringify({ body: 'Edited content' }),
        jar: owner.jar,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((res.body.data as { body: string }).body, 'Edited content');
      assert.ok((res.body.data as { editedAt: string }).editedAt);
    });

    test('cannot edit another user message', async () => {
      const send = await jsonRequest(messageUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ body: 'Owner message' }),
        jar: owner.jar,
      });
      const msgId = (send.body.data as { id: string }).id;

      const res = await jsonRequest(`${messageUrl()}/${msgId}`, {
        method: 'PATCH',
        headers: auth(member),
        body: JSON.stringify({ body: 'Hacked' }),
        jar: member.jar,
      });
      assert.equal(res.status, 403);
    });

    test('can delete own message', async () => {
      const send = await jsonRequest(messageUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ body: 'Delete me' }),
        jar: owner.jar,
      });
      const msgId = (send.body.data as { id: string }).id;

      const res = await jsonRequest(`${messageUrl()}/${msgId}`, {
        method: 'DELETE',
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(res.status, 200);
    });

    test('can add and remove reactions', async () => {
      const send = await jsonRequest(messageUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ body: 'React to me' }),
        jar: owner.jar,
      });
      const msgId = (send.body.data as { id: string }).id;

      const addRes = await jsonRequest(`${messageUrl()}/${msgId}/reactions`, {
        method: 'POST',
        headers: auth(member),
        body: JSON.stringify({ emoji: '👍' }),
        jar: member.jar,
      });
      assert.equal(addRes.status, 201);

      const delRes = await jsonRequest(`${messageUrl()}/${msgId}/reactions?emoji=👍`, {
        method: 'DELETE',
        headers: auth(member),
        jar: member.jar,
      });
      assert.equal(delRes.status, 200);
    });

    test('can mark as read and get unread count', async () => {
      // Send a message as owner
      const send = await jsonRequest(messageUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ body: 'Unread test' }),
        jar: owner.jar,
      });
      const msgId = (send.body.data as { id: string }).id;

      // Member should have unread > 0
      const unreadRes = await jsonRequest(`${channelUrl()}/${channelId}/unread-count`, {
        headers: auth(member),
        jar: member.jar,
      });
      assert.equal(unreadRes.status, 200);
      const unread = (unreadRes.body.data as { unreadCount: number }).unreadCount;
      assert.ok(unread > 0, 'member should have unread messages');

      // Mark as read
      const readRes = await jsonRequest(`${messageUrl()}/${msgId}/read`, {
        method: 'POST',
        headers: auth(member),
        jar: member.jar,
      });
      assert.equal(readRes.status, 200);

      // Unread should be 0 now
      const afterRes = await jsonRequest(`${channelUrl()}/${channelId}/unread-count`, {
        headers: auth(member),
        jar: member.jar,
      });
      const after = (afterRes.body.data as { unreadCount: number }).unreadCount;
      assert.equal(after, 0, 'unread should be 0 after marking read');
    });

    test('can send and list replies', async () => {
      const parent = await jsonRequest(messageUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ body: 'Parent message' }),
        jar: owner.jar,
      });
      const parentId = (parent.body.data as { id: string }).id;

      const reply = await jsonRequest(messageUrl(), {
        method: 'POST',
        headers: auth(member),
        body: JSON.stringify({ body: 'Reply content', parentId }),
        jar: member.jar,
      });
      assert.equal(reply.status, 201, JSON.stringify(reply.body));

      const replies = await jsonRequest(`${messageUrl()}/${parentId}/replies`, {
        headers: auth(owner),
        jar: owner.jar,
      });
      assert.equal(replies.status, 200);
      const items = (replies.body.data as Array<{ body: string }>);
      assert.ok(items.some((r) => r.body === 'Reply content'));
    });

    test('cannot send nested replies', async () => {
      const parent = await jsonRequest(messageUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ body: 'Parent' }),
        jar: owner.jar,
      });
      const parentId = (parent.body.data as { id: string }).id;

      const reply = await jsonRequest(messageUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ body: 'First reply', parentId }),
        jar: owner.jar,
      });
      const replyId = (reply.body.data as { id: string }).id;

      const nested = await jsonRequest(messageUrl(), {
        method: 'POST',
        headers: auth(owner),
        body: JSON.stringify({ body: 'Nested', parentId: replyId }),
        jar: owner.jar,
      });
      assert.equal(nested.status, 400);
      assert.equal((nested.body.error as { code: string }).code, 'NESTED_REPLY_NOT_ALLOWED');
    });
  });
}
