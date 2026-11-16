import { beforeEach, describe, expect, it, vi } from 'vitest';

const ioMocks = vi.hoisted(() => ({
  emitToUser: vi.fn(),
  emitToChannel: vi.fn(),
  emitToWorkspace: vi.fn(),
}));

vi.mock('../../realtime/io-registry', () => ({
  emitToUser: ioMocks.emitToUser,
  emitToChannel: ioMocks.emitToChannel,
  emitToWorkspace: ioMocks.emitToWorkspace,
  getIo: vi.fn(() => null),
  setIo: vi.fn(),
}));

// Mock auth middleware for router tests (we assert API behavior, not auth internals)
vi.mock('../../middleware/authenticate', () => ({
  createRequireAuth: () => (req: any, _res: any, next: any) => {
    req.auth = { userId: 'u1', sessionId: 's1', email: 'u1@test', name: 'U1', status: 'ACTIVE' };
    next();
  },
  createRequireActiveAccount: () => (_req: any, _res: any, next: any) => next(),
}));

import {
  domainEvents,
  emitDomainEvent,
  registerDefaultDomainEventHandlers,
} from '../../realtime/domain-events';
import { createNotification } from '../../services/notifications';
import { createNotificationService } from '../notifications/notification.service';
import { createNotificationRouter } from '../notifications/notification.routes';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

function waitMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

describe('domain event realtime emissions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerDefaultDomainEventHandlers();
  });

  it('emits message.created to the channel room only (and compatibility message:new)', async () => {
    emitDomainEvent('message.created', {
      workspaceId: 'ws1',
      channelId: 'ch1',
      message: { id: 'm1', body: 'hi' },
    });
    await waitMicrotasks();

    expect(ioMocks.emitToChannel).toHaveBeenCalledWith(
      'ch1',
      'message.created',
      expect.objectContaining({ workspaceId: 'ws1', channelId: 'ch1' }),
    );
    expect(ioMocks.emitToChannel).toHaveBeenCalledWith(
      'ch1',
      'message:new',
      expect.objectContaining({ workspaceId: 'ws1', channelId: 'ch1' }),
    );
    expect(ioMocks.emitToWorkspace).not.toHaveBeenCalled();
    expect(ioMocks.emitToUser).not.toHaveBeenCalled();
  });

  it('emits task.created to the workspace room only', async () => {
    emitDomainEvent('task.created', {
      workspaceId: 'ws1',
      projectId: 'p1',
      taskId: 't1',
      actorId: 'u1',
    });
    await waitMicrotasks();

    expect(ioMocks.emitToWorkspace).toHaveBeenCalledWith(
      'ws1',
      'task.created',
      expect.objectContaining({ taskId: 't1', projectId: 'p1' }),
    );
    expect(ioMocks.emitToChannel).not.toHaveBeenCalled();
    expect(ioMocks.emitToUser).not.toHaveBeenCalled();
  });

  it('emits task.updated to the workspace room only', async () => {
    emitDomainEvent('task.updated', {
      workspaceId: 'ws1',
      projectId: 'p1',
      taskId: 't1',
      changes: ['status'],
      actorId: 'u1',
    });
    await waitMicrotasks();

    expect(ioMocks.emitToWorkspace).toHaveBeenCalledWith(
      'ws1',
      'task.updated',
      expect.objectContaining({ taskId: 't1', changes: ['status'] }),
    );
    expect(ioMocks.emitToChannel).not.toHaveBeenCalled();
    expect(ioMocks.emitToUser).not.toHaveBeenCalled();
  });

  it('emits task.assigned to the assignee user and workspace room', async () => {
    emitDomainEvent('task.assigned', {
      workspaceId: 'ws1',
      projectId: 'p1',
      taskId: 't1',
      assigneeId: 'u2',
      actorId: 'u1',
    });
    await waitMicrotasks();

    expect(ioMocks.emitToUser).toHaveBeenCalledWith(
      'u2',
      'task.assigned',
      expect.objectContaining({ assigneeId: 'u2', taskId: 't1' }),
    );
    expect(ioMocks.emitToWorkspace).toHaveBeenCalledWith(
      'ws1',
      'task.assigned',
      expect.objectContaining({ assigneeId: 'u2', taskId: 't1' }),
    );
    expect(ioMocks.emitToChannel).not.toHaveBeenCalled();
  });

  it('emits comment.created to the workspace room only', async () => {
    emitDomainEvent('comment.created', {
      workspaceId: 'ws1',
      projectId: 'p1',
      taskId: 't1',
      commentId: 'c1',
      authorId: 'u1',
    });
    await waitMicrotasks();

    expect(ioMocks.emitToWorkspace).toHaveBeenCalledWith(
      'ws1',
      'comment.created',
      expect.objectContaining({ commentId: 'c1', taskId: 't1' }),
    );
    expect(ioMocks.emitToChannel).not.toHaveBeenCalled();
    expect(ioMocks.emitToUser).not.toHaveBeenCalled();
  });

  it('emits mention.created to the mentioned user only', async () => {
    emitDomainEvent('mention.created', {
      workspaceId: 'ws1',
      projectId: 'p1',
      taskId: 't1',
      commentId: 'c1',
      mentionedUserId: 'u2',
      actorId: 'u1',
    });
    await waitMicrotasks();

    expect(ioMocks.emitToUser).toHaveBeenCalledWith(
      'u2',
      'mention.created',
      expect.objectContaining({ mentionedUserId: 'u2', commentId: 'c1' }),
    );
    expect(ioMocks.emitToWorkspace).not.toHaveBeenCalled();
    expect(ioMocks.emitToChannel).not.toHaveBeenCalled();
  });
});

describe('notification creation (existing preference rules + realtime)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates in-app notification and emits realtime to user when preference allows', async () => {
    const created = {
      id: 'n1',
      userId: 'u1',
      type: 'TASK_ASSIGNED',
      title: 'Task assigned',
      body: null,
      link: null,
      data: { workspaceId: 'ws1' },
      readAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    const client: any = {
      notificationPreference: { findUnique: vi.fn(async () => ({ inAppEnabled: true })) },
      notification: { create: vi.fn(async () => created) },
    };

    const result = await createNotification(client, {
      userId: 'u1',
      type: 'TASK_ASSIGNED' as any,
      title: 'Task assigned',
      data: { workspaceId: 'ws1' },
    });

    expect(result?.id).toBe('n1');
    expect(client.notification.create).toHaveBeenCalled();
    expect(ioMocks.emitToUser).toHaveBeenCalledWith(
      'u1',
      'notification.created',
      expect.objectContaining({
        notification: expect.objectContaining({ id: 'n1', type: 'TASK_ASSIGNED' }),
      }),
    );
  });

  it('respects existing preference rule: skips in-app notification when inAppEnabled is false', async () => {
    const client: any = {
      notificationPreference: { findUnique: vi.fn(async () => ({ inAppEnabled: false })) },
      notification: { create: vi.fn(async () => { throw new Error('should not create'); }) },
    };

    const result = await createNotification(client, {
      userId: 'u1',
      type: 'MENTION' as any,
      title: 'Mentioned',
      data: { workspaceId: 'ws1' },
    });

    expect(result).toBeNull();
    expect(client.notification.create).not.toHaveBeenCalled();
    expect(ioMocks.emitToUser).not.toHaveBeenCalled();
  });
});

describe('notifications API and service contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('service lists with cursor and unread count (separate from message unread counts)', async () => {
    const prisma: any = {
      notification: {
        findMany: vi.fn(async () => [
          {
            id: 'n2',
            type: 'MENTION',
            title: 'hi',
            body: null,
            link: null,
            data: null,
            readAt: null,
            createdAt: new Date('2026-01-02T00:00:00Z'),
          },
          {
            id: 'n1',
            type: 'TASK_ASSIGNED',
            title: 'x',
            body: null,
            link: null,
            data: null,
            readAt: new Date('2026-01-01T00:00:00Z'),
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ]),
        count: vi.fn(async () => 1),
      },
    };
    const svc = createNotificationService(prisma);
    const res = await svc.list({ userId: 'u1', limit: 1, cursor: undefined });

    expect(res.items).toHaveLength(1);
    expect(res.nextCursor).toBe('n2');
    expect(res.unreadCount).toBe(1); // general notifications only
    expect(prisma.notification.findMany).toHaveBeenCalled();
  });

  it('service unread count, mark read, mark all read use notification table', async () => {
    const prisma: any = {
      notification: {
        count: vi.fn(async () => 4),
        updateMany: vi.fn(async () => ({ count: 2 })),
      },
    };
    const svc = createNotificationService(prisma);

    await expect(svc.getUnreadCount({ userId: 'u1' })).resolves.toEqual({ unreadCount: 4 });
    await svc.markRead({ userId: 'u1', notificationIds: ['n1', 'n2'] });
    expect(prisma.notification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['n1', 'n2'] }, userId: 'u1' } }),
    );
    await svc.markAllRead({ userId: 'u1' });
    expect(prisma.notification.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { userId: 'u1', readAt: null } }),
    );
  });

  function makeApp(service: any) {
    const app = express();
    app.use(express.json());
    const router = createNotificationRouter({
      config: {
        jwtAccessSecret: 'test',
        jwtAccessExpiresIn: '15m',
        refreshCookieName: 'nexus_rt',
      } as any,
      service,
    });
    app.use('/notifications', router);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode || 500).json({ success: false, error: { code: err.code || 'ERR', message: err.message } });
    });
    return app;
  }

  it('GET /notifications returns cursor-paginated list and unreadCount', async () => {
    const service = {
      list: vi.fn(async () => ({
        items: [{ id: 'n1', type: 'MENTION', title: 'hi', body: null, link: null, data: null, readAt: null, createdAt: '2026-01-01T00:00:00Z' }],
        nextCursor: 'n1',
        unreadCount: 3,
      })),
    };
    const app = makeApp(service);
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/notifications?limit=10`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.nextCursor).toBe('n1');
      expect(body.data.unreadCount).toBe(3);
      expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', limit: 10 }));
    });
  });

  it('GET /notifications/unread-count returns unread count', async () => {
    const service = { getUnreadCount: vi.fn(async () => ({ unreadCount: 7 })) };
    const app = makeApp(service);
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/notifications/unread-count`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.unreadCount).toBe(7);
      expect(service.getUnreadCount).toHaveBeenCalledWith({ userId: 'u1' });
    });
  });

  it('POST /notifications/read marks specific notifications read', async () => {
    const service = { markRead: vi.fn(async () => undefined) };
    const app = makeApp(service);
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/notifications/read`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notificationIds: ['11111111-1111-4111-8111-111111111111'] }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.ok).toBe(true);
      expect(service.markRead).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', notificationIds: ['11111111-1111-4111-8111-111111111111'] }),
      );
    });
  });

  it('POST /notifications/read-all marks all notifications read', async () => {
    const service = { markAllRead: vi.fn(async () => undefined) };
    const app = makeApp(service);
    await withServer(app, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/notifications/read-all`, { method: 'POST' });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data.ok).toBe(true);
      expect(service.markAllRead).toHaveBeenCalledWith({ userId: 'u1' });
    });
  });
});

// Sanity: domain event bus remains usable/idempotent registration
describe('domain event bus', () => {
  it('registers handlers once (idempotent)', async () => {
    vi.clearAllMocks();
    registerDefaultDomainEventHandlers();
    registerDefaultDomainEventHandlers();
    emitDomainEvent('message.created', { workspaceId: 'w', channelId: 'c', message: { id: 'm' } });
    await waitMicrotasks();
    expect(ioMocks.emitToChannel).toHaveBeenCalledTimes(2);
  });
});
