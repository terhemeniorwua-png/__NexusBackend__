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

import { createCalendarService } from './calendar.service';
import { createCalendarRouter } from './calendar.routes';
import { AppError } from '../../utils/errors';

const ws = '11111111-1111-4111-8111-111111111111';
const eid = '22222222-2222-4222-8222-222222222222';
const uid2 = '33333333-3333-4333-8333-333333333333';
const now = new Date('2026-01-02T10:00:00.000Z');

function makeEvent(overrides: any = {}) {
  return {
    id: eid,
    workspaceId: ws,
    projectId: null,
    createdById: 'u1',
    title: 'Standup',
    description: null,
    location: null,
    startAt: now,
    endAt: new Date('2026-01-02T11:00:00.000Z'),
    allDay: false,
    status: 'CONFIRMED',
    visibility: 'PUBLIC',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function makePrisma() {
  const base: any = {
    calendarEvent: {
      create: vi.fn(async ({ data }: any) => makeEvent(data)),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(async ({ data }: any) => makeEvent({ ...data })),
    },
    eventInvitation: {
      createMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async () => ({ id: 'inv1' })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(async () => ({ id: 'inv1' })),
    },
    project: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: any) => fn(base)),
  };
  return base;
}

async function withServer(app: express.Express, fn: (baseUrl: string) => Promise<void>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

describe('calendar/events module (service)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsAuth.requireWorkspaceAccess.mockResolvedValue({ effectiveRole: 'MEMBER', membership: { organizationRole: null } });
    projAuth.requireProjectAccess.mockResolvedValue({});
  });

  it('happy path: create/list/get/update/cancel/delete and invitation mutations with audits', async () => {
    const prisma = makePrisma();
    const e = makeEvent();
    prisma.calendarEvent.findFirst.mockResolvedValue(e);
    prisma.calendarEvent.findMany.mockResolvedValue([e, makeEvent({ id: 'e0' })]);
    prisma.eventInvitation.findMany.mockResolvedValue([
      { user: { id: uid2, name: 'U2' }, status: 'PENDING', createdAt: now },
    ]);
    prisma.eventInvitation.findUnique.mockResolvedValue({
      id: 'inv1',
      event: { id: eid, workspaceId: ws, deletedAt: null },
    });

    const svc = createCalendarService(prisma as any);

    const created = await svc.create({
      userId: 'u1', workspaceId: ws, title: 'Standup',
      startAt: '2026-01-02T10:00:00.000Z', endAt: '2026-01-02T11:00:00.000Z',
      allDay: false, status: 'CONFIRMED', visibility: 'PUBLIC', inviteeIds: [uid2],
    });
    expect(created.id).toBe(eid);
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'calendar.event_created' }));

    const listed = await svc.list({ userId: 'u1', workspaceId: ws, limit: 1 });
    expect(listed.items).toHaveLength(1);
    expect(listed.nextCursor).toBe(eid);

    const got = await svc.get({ userId: 'u1', workspaceId: ws, eventId: eid });
    expect(got.title).toBe('Standup');

    const updated = await svc.update({ userId: 'u1', workspaceId: ws, eventId: eid, title: 'New' });
    expect(updated.id).toBe(eid);
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'calendar.event_updated' }));

    await svc.cancel({ userId: 'u1', workspaceId: ws, eventId: eid });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'calendar.event_cancelled' }));

    await svc.addInvitee({ userId: 'u1', workspaceId: ws, eventId: eid, targetUserId: uid2 });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'calendar.invitee_added' }));

    const invs = await svc.listInvitations({ userId: 'u1', workspaceId: ws, eventId: eid });
    expect(invs).toEqual([{ userId: uid2, status: 'PENDING', createdAt: now.toISOString() }]);

    await svc.respondToInvitation({ userId: 'u1', workspaceId: ws, eventId: eid, status: 'ACCEPTED' });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'calendar.invitation_responded' }));

    await svc.removeInvitee({ userId: 'u1', workspaceId: ws, eventId: eid, targetUserId: uid2 });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'calendar.invitee_removed' }));

    await svc.delete({ userId: 'u1', workspaceId: ws, eventId: eid });
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'calendar.event_deleted' }));
  });

  it('permission denied: workspace access denied and non-manager/non-creator cannot manage', async () => {
    const prisma = makePrisma();
    const svc = createCalendarService(prisma as any);

    wsAuth.requireWorkspaceAccess.mockRejectedValue(new AppError(403, 'FORBIDDEN', 'no access'));
    await expect(svc.list({ userId: 'u2', workspaceId: ws, limit: 10 })).rejects.toMatchObject({ statusCode: 403 });

    wsAuth.requireWorkspaceAccess.mockResolvedValue({ effectiveRole: 'MEMBER', membership: { organizationRole: null } });
    prisma.calendarEvent.findFirst.mockResolvedValue(makeEvent({ createdById: 'owner' }));
    await expect(svc.update({ userId: 'u2', workspaceId: ws, eventId: eid, title: 'x' })).rejects.toMatchObject({ statusCode: 403, code: 'EVENT_EDIT_FORBIDDEN' });
    await expect(svc.cancel({ userId: 'u2', workspaceId: ws, eventId: eid })).rejects.toMatchObject({ statusCode: 403, code: 'EVENT_EDIT_FORBIDDEN' });
    await expect(svc.addInvitee({ userId: 'u2', workspaceId: ws, eventId: eid, targetUserId: uid2 })).rejects.toMatchObject({ statusCode: 403, code: 'EVENT_EDIT_FORBIDDEN' });
  });

  it('cross-workspace isolation: foreign workspace event not found and respond scoped to workspace', async () => {
    const prisma = makePrisma();
    const svc = createCalendarService(prisma as any);
    prisma.calendarEvent.findFirst.mockResolvedValue(null);

    await expect(svc.get({ userId: 'u1', workspaceId: '44444444-4444-4444-8444-444444444444', eventId: eid }))
      .rejects.toMatchObject({ statusCode: 404, code: 'EVENT_NOT_FOUND' });
    expect(prisma.calendarEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: eid, workspaceId: '44444444-4444-4444-8444-444444444444', deletedAt: null }),
    }));

    prisma.eventInvitation.findUnique.mockResolvedValue({
      id: 'inv1',
      event: { id: eid, workspaceId: ws, deletedAt: null },
    });
    await expect(svc.respondToInvitation({ userId: 'u1', workspaceId: '44444444-4444-4444-8444-444444444444', eventId: eid, status: 'ACCEPTED' }))
      .rejects.toMatchObject({ statusCode: 404, code: 'INVITATION_NOT_FOUND' });
  });
});

describe('calendar/events module (routes contract)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes return contract shapes including cursor list and {ok:true} mutations', async () => {
    const ev = {
      id: eid, workspaceId: ws, projectId: null, createdById: 'u1', title: 'T',
      description: null, location: null, startAt: '2026-01-02T10:00:00.000Z',
      endAt: '2026-01-02T11:00:00.000Z', allDay: false, status: 'CONFIRMED',
      visibility: 'PUBLIC', createdAt: '2026-01-02T10:00:00.000Z', updatedAt: '2026-01-02T10:00:00.000Z',
    };
    const service: any = {
      list: vi.fn(async () => ({ items: [ev], nextCursor: null })),
      create: vi.fn(async () => ev),
      get: vi.fn(async () => ev),
      update: vi.fn(async () => ev),
      cancel: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      listInvitations: vi.fn(async () => [{ userId: uid2, status: 'PENDING', createdAt: '2026-01-02T10:00:00.000Z' }]),
      addInvitee: vi.fn(async () => undefined),
      removeInvitee: vi.fn(async () => undefined),
      respondToInvitation: vi.fn(async () => undefined),
    };
    const app = express();
    app.use(express.json());
    app.use('/workspaces/:workspaceId/events', createCalendarRouter({ config: {} as any, service }));
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ success: false, error: { code: err.code || 'ERR', message: err.message } }));

    await withServer(app, async (baseUrl) => {
      let res = await fetch(`${baseUrl}/workspaces/${ws}/events?limit=10`);
      let body = await res.json();
      expect(body.data).toEqual({ items: [ev], nextCursor: null });

      res = await fetch(`${baseUrl}/workspaces/${ws}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'T', startAt: '2026-01-02T10:00:00.000Z', endAt: '2026-01-02T11:00:00.000Z' }) });
      expect(res.status).toBe(201);
      body = await res.json();
      expect(body.data.id).toBe(eid);

      res = await fetch(`${baseUrl}/workspaces/${ws}/events/${eid}`);
      body = await res.json();
      expect(body.data.title).toBe('T');

      res = await fetch(`${baseUrl}/workspaces/${ws}/events/${eid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'T2' }) });
      body = await res.json();
      expect(body.data.id).toBe(eid);

      res = await fetch(`${baseUrl}/workspaces/${ws}/events/${eid}/cancel`, { method: 'POST' });
      body = await res.json();
      expect(body.data).toEqual({ ok: true });

      res = await fetch(`${baseUrl}/workspaces/${ws}/events/${eid}/invitations`);
      body = await res.json();
      expect(body.data).toEqual([{ userId: uid2, status: 'PENDING', createdAt: '2026-01-02T10:00:00.000Z' }]);

      res = await fetch(`${baseUrl}/workspaces/${ws}/events/${eid}/invitations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: uid2 }) });
      expect(res.status).toBe(201);
      body = await res.json();
      expect(body.data).toEqual({ ok: true });

      res = await fetch(`${baseUrl}/workspaces/${ws}/events/${eid}/respond`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'ACCEPTED' }) });
      body = await res.json();
      expect(body.data).toEqual({ ok: true });

      res = await fetch(`${baseUrl}/workspaces/${ws}/events/${eid}/invitations/${uid2}`, { method: 'DELETE' });
      body = await res.json();
      expect(body.data).toEqual({ ok: true });

      res = await fetch(`${baseUrl}/workspaces/${ws}/events/${eid}`, { method: 'DELETE' });
      body = await res.json();
      expect(body.data).toEqual({ ok: true });
    });
  });
});
