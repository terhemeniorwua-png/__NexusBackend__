/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const wsAuth = vi.hoisted(() => ({
  requireWorkspaceAccess: vi.fn(),
  WorkspaceCapability: { ViewWorkspace: 'workspace:view' },
}));
const projAuth = vi.hoisted(() => ({
  requireProjectAccess: vi.fn(),
  ProjectCapability: { ViewProject: 'project:view' },
}));
const visibility = vi.hoisted(() => ({
  projectVisibleToUser: vi.fn(() => ({ OR: [{ visibility: 'WORKSPACE' }] })),
}));
const audit = vi.hoisted(() => ({ recordAuditEvent: vi.fn(async () => undefined) }));
const notif = vi.hoisted(() => ({ createNotification: vi.fn(async () => undefined) }));

vi.mock('../workspaces/authorization', () => wsAuth);
vi.mock('../authorization/project.policy', () => projAuth);
vi.mock('../projects/project-visibility', () => visibility);
vi.mock('../../services/audit', () => audit);
vi.mock('../../services/notifications', () => notif);
vi.mock('../../middleware/authenticate', () => ({
  createRequireAuth: () => (req: any, _res: any, next: any) => {
    req.auth = { userId: 'u1', sessionId: 's1', email: 'u1@test', name: 'U1', status: 'ACTIVE' };
    next();
  },
  createRequireActiveAccount: () => (_req: any, _res: any, next: any) => next(),
}));

import { createMeetingService } from './meeting.service';
import { createMeetingRouter } from './meeting.routes';
import { AppError } from '../../utils/errors';

const ws = '11111111-1111-4111-8111-111111111111';
const mid = '22222222-2222-4222-8222-222222222222';
const uid2 = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-01-02T10:00:00.000Z');

function makeMeeting(overrides: any = {}) {
  return {
    id: mid, workspaceId: ws, projectId: null, createdById: 'u1', title: 'Sync',
    description: null, status: 'SCHEDULED', scheduledAt: now, startedAt: null, endedAt: null,
    createdAt: now, updatedAt: now, deletedAt: null, _count: { participants: 0 }, ...overrides,
  };
}

function makePrisma() {
  const base: any = {
    meeting: {
      create: vi.fn(async ({ data }: any) => makeMeeting({ ...data, scheduledAt: data.scheduledAt ?? null })),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(async ({ data }: any) => makeMeeting({ ...data })),
    },
    meetingParticipant: {
      createMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: any) => fn(base)),
  };
  return base;
}

async function withServer(app: express.Express, fn: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))); }
}

describe('meetings module (service)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsAuth.requireWorkspaceAccess.mockResolvedValue({ effectiveRole: 'MEMBER', membership: { organizationRole: null } });
  });

  it('happy path: create/list/get/update/join/leave/participants/delete with audits and cursor', async () => {
    const prisma = makePrisma();
    const m = makeMeeting();
    prisma.meeting.findFirst.mockResolvedValue(m);
    prisma.meeting.findMany.mockResolvedValue([m, makeMeeting({ id: 'm0' })]);
    prisma.meetingParticipant.findMany.mockResolvedValue([
      { user: { id: uid2, name: 'U2' }, status: 'INVITED', joinedAt: null, leftAt: null },
    ]);

    const svc = createMeetingService(prisma as any);

    const created = await svc.create({ userId: 'u1', workspaceId: ws, title: 'Sync', participantIds: [uid2] });
    expect(created.participantCount).toBe(0);
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'meeting.created' }));

    const listed = await svc.list({ userId: 'u1', workspaceId: ws, limit: 1 });
    expect(listed.items).toHaveLength(1);
    expect(listed.nextCursor).toBe(mid);

    const got = await svc.get({ userId: 'u1', workspaceId: ws, meetingId: mid });
    expect(got.title).toBe('Sync');

    const updated = await svc.update({ userId: 'u1', workspaceId: ws, meetingId: mid, title: 'New' });
    expect(updated.id).toBe(mid);
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'meeting.updated' }));

    await svc.join({ userId: 'u1', workspaceId: ws, meetingId: mid });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'meeting.joined' }));

    await svc.leave({ userId: 'u1', workspaceId: ws, meetingId: mid });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'meeting.left' }));

    await svc.addParticipant({ userId: 'u1', workspaceId: ws, meetingId: mid, targetUserId: uid2 });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'meeting.participant_added' }));

    const parts = await svc.listParticipants({ userId: 'u1', workspaceId: ws, meetingId: mid });
    expect(parts).toEqual([{ userId: uid2, status: 'INVITED', joinedAt: null, leftAt: null }]);

    await svc.removeParticipant({ userId: 'u1', workspaceId: ws, meetingId: mid, targetUserId: uid2 });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'meeting.participant_removed' }));

    await svc.delete({ userId: 'u1', workspaceId: ws, meetingId: mid });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'meeting.deleted' }));
  });

  it('permission denied: workspace access denied and non-manager/non-creator cannot manage meeting or remove others', async () => {
    const prisma = makePrisma();
    const svc = createMeetingService(prisma as any);

    wsAuth.requireWorkspaceAccess.mockRejectedValue(new AppError(403, 'FORBIDDEN', 'no access'));
    await expect(svc.list({ userId: 'u2', workspaceId: ws, limit: 10 })).rejects.toMatchObject({ statusCode: 403 });

    wsAuth.requireWorkspaceAccess.mockResolvedValue({ effectiveRole: 'MEMBER', membership: { organizationRole: null } });
    prisma.meeting.findFirst.mockResolvedValue(makeMeeting({ createdById: 'owner' }));
    await expect(svc.update({ userId: 'u2', workspaceId: ws, meetingId: mid, title: 'x' })).rejects.toMatchObject({ statusCode: 403, code: 'MEETING_EDIT_FORBIDDEN' });
    await expect(svc.delete({ userId: 'u2', workspaceId: ws, meetingId: mid })).rejects.toMatchObject({ statusCode: 403, code: 'MEETING_DELETE_FORBIDDEN' });
    await expect(svc.removeParticipant({ userId: 'u2', workspaceId: ws, meetingId: mid, targetUserId: uid2 })).rejects.toMatchObject({ statusCode: 403, code: 'MEETING_PARTICIPANT_FORBIDDEN' });
  });

  it('cross-workspace isolation: meeting lookup scoped to workspace returns not found', async () => {
    const prisma = makePrisma();
    const svc = createMeetingService(prisma as any);
    prisma.meeting.findFirst.mockResolvedValue(null);
    const otherWs = '44444444-4444-4444-8444-444444444444';

    await expect(svc.get({ userId: 'u1', workspaceId: otherWs, meetingId: mid })).rejects.toMatchObject({ statusCode: 404, code: 'MEETING_NOT_FOUND' });
    expect(prisma.meeting.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: mid, workspaceId: otherWs, deletedAt: null }),
    }));
  });
});

describe('meetings module (routes contract)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('core routes return contract shapes including cursor list and {ok:true} mutations', async () => {
    const meeting = {
      id: mid, workspaceId: ws, projectId: null, createdById: 'u1', title: 'Sync', description: null,
      status: 'SCHEDULED', scheduledAt: '2026-01-02T10:00:00.000Z', startedAt: null, endedAt: null,
      createdAt: '2026-01-02T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z', participantCount: 0,
    };
    const service: any = {
      list: vi.fn(async () => ({ items: [meeting], nextCursor: null })),
      create: vi.fn(async () => meeting),
      get: vi.fn(async () => meeting),
      update: vi.fn(async () => meeting),
      delete: vi.fn(async () => undefined),
      join: vi.fn(async () => undefined),
      leave: vi.fn(async () => undefined),
      listParticipants: vi.fn(async () => [{ userId: uid2, status: 'INVITED', joinedAt: null, leftAt: null }]),
      addParticipant: vi.fn(async () => undefined),
      removeParticipant: vi.fn(async () => undefined),
    };
    const app = express();
    app.use(express.json());
    app.use('/workspaces/:workspaceId/meetings', createMeetingRouter({ config: {} as any, service }));
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ success: false, error: { code: err.code || 'ERR', message: err.message } }));

    await withServer(app, async (baseUrl) => {
      let res = await fetch(`${baseUrl}/workspaces/${ws}/meetings?limit=10`);
      let body = await res.json();
      expect(body.data).toEqual({ items: [meeting], nextCursor: null });

      res = await fetch(`${baseUrl}/workspaces/${ws}/meetings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Sync' }) });
      expect(res.status).toBe(201);
      body = await res.json();
      expect(body.data.id).toBe(mid);

      res = await fetch(`${baseUrl}/workspaces/${ws}/meetings/${mid}`);
      body = await res.json();
      expect(body.data.title).toBe('Sync');

      res = await fetch(`${baseUrl}/workspaces/${ws}/meetings/${mid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'New' }) });
      body = await res.json();
      expect(body.data.id).toBe(mid);

      res = await fetch(`${baseUrl}/workspaces/${ws}/meetings/${mid}/join`, { method: 'POST' });
      body = await res.json();
      expect(body.data).toEqual({ ok: true });

      res = await fetch(`${baseUrl}/workspaces/${ws}/meetings/${mid}/leave`, { method: 'POST' });
      body = await res.json();
      expect(body.data).toEqual({ ok: true });

      res = await fetch(`${baseUrl}/workspaces/${ws}/meetings/${mid}/participants`);
      body = await res.json();
      expect(body.data).toEqual([{ userId: uid2, status: 'INVITED', joinedAt: null, leftAt: null }]);

      res = await fetch(`${baseUrl}/workspaces/${ws}/meetings/${mid}/participants`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: uid2 }) });
      expect(res.status).toBe(201);
      body = await res.json();
      expect(body.data).toEqual({ ok: true });

      res = await fetch(`${baseUrl}/workspaces/${ws}/meetings/${mid}/participants/${uid2}`, { method: 'DELETE' });
      body = await res.json();
      expect(body.data).toEqual({ ok: true });

      res = await fetch(`${baseUrl}/workspaces/${ws}/meetings/${mid}`, { method: 'DELETE' });
      body = await res.json();
      expect(body.data).toEqual({ ok: true });
    });
  });
});
