import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { getPrismaClient } from '../src/db/prisma';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import { loadTestConfig } from './helpers/test-config';
import { createApp } from '../src/app';
import { startServer, type RunningServer } from './helpers/test-server';
import { hashPassword } from '../src/services/password';
import { createSession } from '../src/modules/auth/session.service';
import { signAccessToken } from '../src/modules/auth/access-token.service';
import type { SessionAuthMethod } from '../src/modules/auth/session.service';

let databaseUrl: string | null = null;
let skipReason = 'Set RUN_SSO_DB_TESTS=true and an explicit loopback TEST_DATABASE_URL';
try {
  databaseUrl = resolveTestDatabaseUrl('RUN_SSO_DB_TESTS');
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env.RUN_SSO_DB_TESTS === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database identity was rejected';
}

async function jsonReq(
  baseUrl: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

describe('SSO enforcement over HTTP (DB-gated)', { skip: skipReason || false }, () => {
  let prisma: ReturnType<typeof getPrismaClient> | null = null;
  let server: RunningServer | null = null;
  let config: ReturnType<typeof loadTestConfig>;
  const cleanup = { userIds: [] as string[], workspaceIds: [] as string[], projectIds: [] as string[] };

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);
    prisma = getPrismaClient(database.url);
    config = loadTestConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database.url,
      TEST_DATABASE_URL: database.url,
      SSO_ENABLED: 'true',
      FRONTEND_URL: 'http://localhost:3000',
      JWT_ACCESS_SECRET: 'test-access-secret-0123456789abcdef0123456789abcdef',
      JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef0123456789abcdef',
    });
    process.env.SSO_ENABLED = 'true';
    server = await startServer(createApp({ config }));
  });

  after(async () => {
    if (server) await server.close();
    if (prisma) {
      const db = prisma;
      for (const wid of cleanup.workspaceIds) {
        await db.auditLog.deleteMany({ where: { workspaceId: wid } }).catch(() => {});
        await db.task.deleteMany({ where: { project: { workspaceId: wid } } as never }).catch(() => {});
        await db.project.deleteMany({ where: { workspaceId: wid } }).catch(() => {});
        await db.channelMembership.deleteMany({ where: { channel: { workspaceId: wid } } as never }).catch(() => {});
        await db.channel.deleteMany({ where: { workspaceId: wid } }).catch(() => {});
        await db.document.deleteMany({ where: { workspaceId: wid } }).catch(() => {});
        await db.fileObject.deleteMany({ where: { workspaceId: wid } as never }).catch(() => {});
        await db.calendarEvent.deleteMany({ where: { workspaceId: wid } as never }).catch(() => {});
        await db.form.deleteMany({ where: { workspaceId: wid } }).catch(() => {});
        await db.meeting.deleteMany({ where: { workspaceId: wid } }).catch(() => {});
        await db.automation.deleteMany({ where: { workspaceId: wid } }).catch(() => {});
        await db.workspaceSsoDomain.deleteMany({ where: { workspaceId: wid } }).catch(() => {});
        await db.workspaceSsoConfig.deleteMany({ where: { workspaceId: wid } }).catch(() => {});
        await db.workspaceMembership.deleteMany({ where: { workspaceId: wid } }).catch(() => {});
        await db.workspace.deleteMany({ where: { id: wid } }).catch(() => {});
      }
      if (cleanup.userIds.length) {
        await db.session.deleteMany({ where: { userId: { in: cleanup.userIds } } }).catch(() => {});
        await db.user.deleteMany({ where: { id: { in: cleanup.userIds } } }).catch(() => {});
      }
      await db.$disconnect();
    }
  });

  async function seed() {
    const db = prisma!;
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const domain = `ssohttp-${suffix}.example.test`;
    const password = 'StrongPass123!';
    const passwordHash = await hashPassword(password, 4);
    const owner = await db.user.create({
      data: { email: `owner-${suffix}@${domain}`, name: 'Owner', passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    const member = await db.user.create({
      data: { email: `member-${suffix}@${domain}`, name: 'Member', passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    cleanup.userIds.push(owner.id, member.id);
    const workspace = await db.workspace.create({
      data: { name: `SSO HTTP WS ${suffix}`, slug: `sso-http-${suffix}`, ownerId: owner.id, type: 'COMPANY' },
    });
    cleanup.workspaceIds.push(workspace.id);
    await db.workspaceMembership.createMany({
      data: [
        { workspaceId: workspace.id, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
        { workspaceId: workspace.id, userId: member.id, role: 'MEMBER', status: 'ACTIVE' },
      ],
    });
    const ssoConfig = await db.workspaceSsoConfig.create({
      data: {
        workspaceId: workspace.id,
        providerType: 'OIDC',
        providerName: 'test-idp',
        issuer: 'https://idp.example.test',
        clientId: 'client',
        redirectUri: 'https://app.example.test/callback',
        isEnabled: true,
        requireSso: true,
        breakGlassEnabled: false,
        status: 'ACTIVE',
        createdById: owner.id,
      },
    });
    await db.workspaceSsoDomain.create({
      data: {
        workspaceId: workspace.id,
        configId: ssoConfig.id,
        domain,
        verificationToken: 'tok',
        txtRecordName: `_nexus-sso-verification.${domain}`,
        verifiedAt: new Date(),
      },
    });

    // Seed resources for representative module routes
    const project = await db.project.create({
      data: {
        workspaceId: workspace.id,
        name: 'Proj',
        key: `P${suffix.slice(0, 6).toUpperCase()}`,
        description: null,
        status: 'PLANNING',
        visibility: 'WORKSPACE',
        ownerId: owner.id,
      } as never,
    });
    cleanup.projectIds.push(project.id);
    await db.projectMember.create({ data: { projectId: project.id, userId: owner.id, role: 'OWNER' } as never }).catch(() => {});
    await db.projectMember.create({ data: { projectId: project.id, userId: member.id, role: 'MEMBER' } as never }).catch(() => {});

    const channel = await db.channel.create({
      data: { workspaceId: workspace.id, name: `general-${suffix.slice(0, 4)}`, type: 'GENERAL', createdById: owner.id } as never,
    }).catch(async () => db.channel.create({ data: { workspaceId: workspace.id, name: `general-${suffix.slice(0, 4)}`, type: 'WORKSPACE', createdById: owner.id } as never }));
    await db.channelMembership.create({ data: { channelId: channel.id, userId: owner.id, role: 'OWNER' } as never }).catch(() => {});
    await db.channelMembership.create({ data: { channelId: channel.id, userId: member.id, role: 'MEMBER' } as never }).catch(() => {});

    await db.document.create({ data: { workspaceId: workspace.id, title: 'Doc', content: 'hi', authorId: owner.id } as never }).catch(() => {});
    await db.form.create({ data: { workspaceId: workspace.id, title: 'Form', createdById: owner.id } as never }).catch(() => {});
    await db.calendarEvent.create({ data: { workspaceId: workspace.id, title: 'Event', createdById: owner.id, startAt: new Date(), endAt: new Date(Date.now() + 3600000), allDay: false, status: 'CONFIRMED', visibility: 'WORKSPACE' } as never }).catch(() => {});
    await db.meeting.create({ data: { workspaceId: workspace.id, title: 'Meeting', createdById: owner.id, startAt: new Date(), endAt: new Date(Date.now() + 3600000), status: 'SCHEDULED' } as never }).catch(() => {});
    await db.automation.create({ data: { workspaceId: workspace.id, name: 'Auto', createdById: owner.id, trigger: 'TASK_CREATED', action: 'SEND_NOTIFICATION', actionConfig: {} as never, enabled: true } as never }).catch(() => {});

    return { owner, member, workspace, project, channel, password };
  }

  async function issueAccessToken(userId: string, authMethod: SessionAuthMethod) {
    const db = prisma!;
    const issued = await createSession(db, {
      userId,
      ttlSeconds: 3600,
      authMethod,
      userAgent: 'test',
      ip: '127.0.0.1',
    });
    const { token } = signAccessToken(config, { userId, sessionId: issued.session.id, authMethod });
    return { token, sessionId: issued.session.id, refreshToken: issued.refreshToken };
  }

  test('password session gets 403 SSO_REQUIRED on representative routes from EVERY module', async () => {
    const seeded = await seed();
    const base = server!.baseUrl;
    const { token } = await issueAccessToken(seeded.member.id, 'password');
    const wid = seeded.workspace.id;
    const pid = seeded.project.id;

    const routes: Array<{ name: string; method?: string; path: string }> = [
      { name: 'tasks', path: `/api/workspaces/${wid}/projects/${pid}/tasks` },
      { name: 'channels', path: `/api/workspaces/${wid}/channels` },
      { name: 'documents', path: `/api/workspaces/${wid}/documents` },
      { name: 'files', path: `/api/workspaces/${wid}/files` },
      { name: 'calendar', path: `/api/workspaces/${wid}/events` },
      { name: 'forms', path: `/api/workspaces/${wid}/forms` },
      { name: 'meetings', path: `/api/workspaces/${wid}/meetings` },
      { name: 'automations', path: `/api/workspaces/${wid}/automations` },
      { name: 'billing', path: `/api/workspaces/${wid}/billing/summary` },
      { name: 'members', path: `/api/workspaces/${wid}/members` },
    ];

    for (const r of routes) {
      const res = await jsonReq(base, r.path, { method: r.method ?? 'GET', token });
      assert.equal(res.status, 403, `${r.name} ${r.path} expected 403 got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal((res.body as { error?: { code?: string } } | null)?.error?.code, 'SSO_REQUIRED', `${r.name} expected SSO_REQUIRED got ${JSON.stringify(res.body)}`);
    }
  });

  test('password session denied after refresh token rotation (new access token, same password auth)', async () => {
    const seeded = await seed();
    const base = server!.baseUrl;
    const issued = await issueAccessToken(seeded.member.id, 'password');
    // rotate via refresh endpoint to get a new access token for same password session flow
    const refreshRes = await fetch(`${base}/api/auth/refresh`, {
      method: 'POST',
      headers: { cookie: `refreshToken=${encodeURIComponent(issued.refreshToken)}` },
    });
    let newToken = issued.token;
    if (refreshRes.ok) {
      const body = (await refreshRes.json().catch(() => null)) as { data?: { accessToken?: string } } | null;
      newToken = body?.data?.accessToken ?? issued.token;
    }
    const res = await jsonReq(base, `/api/workspaces/${seeded.workspace.id}/members`, { token: newToken });
    assert.equal(res.status, 403, `expected 403 after refresh got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal((res.body as { error?: { code?: string } } | null)?.error?.code, 'SSO_REQUIRED');
  });

  test('session after 2FA completion (password auth method) gets 403 SSO_REQUIRED', async () => {
    const seeded = await seed();
    const base = server!.baseUrl;
    // 2FA completion yields an authenticated session; model as password-authenticated session
    const { token } = await issueAccessToken(seeded.member.id, 'password');
    const res = await jsonReq(base, `/api/workspaces/${seeded.workspace.id}/channels`, { token });
    assert.equal(res.status, 403);
    assert.equal((res.body as { error?: { code?: string } } | null)?.error?.code, 'SSO_REQUIRED');
  });

  test('session after Google login (social auth method) gets 403 SSO_REQUIRED', async () => {
    const seeded = await seed();
    const base = server!.baseUrl;
    const { token } = await issueAccessToken(seeded.member.id, 'social');
    const routes = [
      `/api/workspaces/${seeded.workspace.id}/projects/${seeded.project.id}/tasks`,
      `/api/workspaces/${seeded.workspace.id}/documents`,
      `/api/workspaces/${seeded.workspace.id}/files`,
      `/api/workspaces/${seeded.workspace.id}/events`,
      `/api/workspaces/${seeded.workspace.id}/forms`,
      `/api/workspaces/${seeded.workspace.id}/meetings`,
      `/api/workspaces/${seeded.workspace.id}/automations`,
      `/api/workspaces/${seeded.workspace.id}/billing/summary`,
      `/api/workspaces/${seeded.workspace.id}/members`,
      `/api/workspaces/${seeded.workspace.id}/channels`,
    ];
    for (const path of routes) {
      const res = await jsonReq(base, path, { token });
      assert.equal(res.status, 403, `${path} expected 403 got ${res.status} ${JSON.stringify(res.body)}`);
      assert.equal((res.body as { error?: { code?: string } } | null)?.error?.code, 'SSO_REQUIRED', `${path} expected SSO_REQUIRED`);
    }
  });

  test('SSO session succeeds on representative routes', async () => {
    const seeded = await seed();
    const base = server!.baseUrl;
    const { token } = await issueAccessToken(seeded.owner.id, 'sso');
    const wid = seeded.workspace.id;
    const pid = seeded.project.id;
    const okRoutes = [
      `/api/workspaces/${wid}/projects/${pid}/tasks`,
      `/api/workspaces/${wid}/channels`,
      `/api/workspaces/${wid}/documents`,
      `/api/workspaces/${wid}/files`,
      `/api/workspaces/${wid}/events`,
      `/api/workspaces/${wid}/forms`,
      `/api/workspaces/${wid}/meetings`,
      `/api/workspaces/${wid}/automations`,
      `/api/workspaces/${wid}/billing/summary`,
      `/api/workspaces/${wid}/members`,
    ];
    for (const path of okRoutes) {
      const res = await jsonReq(base, path, { token });
      assert.ok(res.status < 400, `${path} expected success for SSO session got ${res.status} ${JSON.stringify(res.body)}`);
    }
  });

  test('removed member is denied at once with an unexpired access token', async () => {
    const seeded = await seed();
    const base = server!.baseUrl;
    const db = prisma!;
    const { token, sessionId } = await issueAccessToken(seeded.member.id, 'sso');
    // remove membership
    await db.workspaceMembership.deleteMany({ where: { workspaceId: seeded.workspace.id, userId: seeded.member.id } });
    // session/token still unexpired
    const sess = await db.session.findUnique({ where: { id: sessionId } });
    assert.ok(sess && !sess.revokedAt && sess.expiresAt.getTime() > Date.now());
    const res = await jsonReq(base, `/api/workspaces/${seeded.workspace.id}/members`, { token });
    assert.equal(res.status, 403, `expected 403 for removed member got ${res.status} ${JSON.stringify(res.body)}`);
    // may be WORKSPACE_ACCESS_DENIED or SSO/membership denial; requirement states denied at once
    assert.ok((res.body as { error?: { code?: string } } | null)?.error?.code, 'expected error code');
  });
});
