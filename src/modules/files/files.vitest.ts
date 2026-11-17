/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const wsAuth = vi.hoisted(() => ({
  requireWorkspaceAccess: vi.fn(),
  WorkspaceCapability: { ViewWorkspace: 'workspace:view' },
}));
const projAuth = vi.hoisted(() => ({
  authorizeProject: vi.fn(),
  getProjectAuthorization: vi.fn(),
  ProjectPermission: {
    View: 'project.view',
    FileUpload: 'file.upload',
    FileDeleteOwn: 'file.delete_own',
    FileDeleteAny: 'file.delete_any',
  },
}));
const audit = vi.hoisted(() => ({ recordAuditEvent: vi.fn(async () => undefined) }));

vi.mock('../workspaces/authorization', () => wsAuth);
vi.mock('../authorization', () => projAuth);
vi.mock('../../services/audit', () => audit);
vi.mock('../../middleware/authenticate', () => ({
  createRequireAuth: () => (req: any, _res: any, next: any) => {
    req.auth = { userId: 'u1', sessionId: 's1', email: 'u1@test', name: 'U1', status: 'ACTIVE' };
    next();
  },
  createRequireActiveAccount: () => (_req: any, _res: any, next: any) => next(),
}));

import { createFileService } from './file.service';
import { createFileRouter } from './file.routes';
import { AppError } from '../../utils/errors';

function makePrisma(overrides: Record<string, any> = {}) {
  const base: any = {
    fileAttachment: {
      create: vi.fn(async ({ data }: any) => ({
        id: 'f1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        deletedAt: null,
        extractedText: null,
        textExtractedAt: null,
        commentId: null,
        storageKey: data.storageKey,
        ...data,
      })),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 123 } })),
      count: vi.fn(async () => 1),
      update: vi.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    $transaction: vi.fn(async (fn: any) => fn(base)),
  };
  return { ...base, ...overrides };
}

function makeStorage() {
  return {
    put: vi.fn(async () => undefined),
    get: vi.fn(async () => ({ body: Buffer.from('hello'), contentType: 'text/plain' })),
    delete: vi.fn(async () => undefined),
  };
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

describe('files module (service)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsAuth.requireWorkspaceAccess.mockResolvedValue({ effectiveRole: 'MEMBER' });
    projAuth.authorizeProject.mockResolvedValue({});
    projAuth.getProjectAuthorization.mockResolvedValue({ permissions: [] });
  });

  it('happy path: uploads, lists with cursor, returns usage, downloads, and deletes own workspace file', async () => {
    const prisma = makePrisma();
    const storage = makeStorage();
    prisma.fileAttachment.findMany.mockResolvedValue([
      { id: 'f2', workspaceId: '11111111-1111-4111-8111-111111111111', projectId: null, taskId: null, uploadedById: 'u1', fileName: 'b.txt', mimeType: 'text/plain', sizeBytes: 10, createdAt: new Date('2026-01-02T00:00:00Z') },
      { id: 'f1', workspaceId: '11111111-1111-4111-8111-111111111111', projectId: null, taskId: null, uploadedById: 'u1', fileName: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, createdAt: new Date('2026-01-01T00:00:00Z') },
    ]);
    prisma.fileAttachment.findFirst.mockResolvedValue({
      id: 'f1', workspaceId: '11111111-1111-4111-8111-111111111111', projectId: null, taskId: null,
      uploadedById: 'u1', fileName: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, storageKey: 'k1',
      createdAt: new Date('2026-01-01T00:00:00Z'), deletedAt: null,
    });
    const svc = createFileService(prisma as any, storage as any);
    const ws = '11111111-1111-4111-8111-111111111111';

    const uploaded = await svc.upload({ userId: 'u1', workspaceId: ws, fileName: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, body: Buffer.from('hello') });
    expect(uploaded.id).toBe('f1');
    expect(storage.put).toHaveBeenCalled();
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'file.uploaded', targetType: 'FileAttachment' }));

    const listed = await svc.list({ userId: 'u1', workspaceId: ws, limit: 1 });
    expect(listed.items).toHaveLength(1);
    expect(listed.nextCursor).toBe('f2');
    expect(listed.totalBytes).toBe(123);

    const usage = await svc.getUsage({ userId: 'u1', workspaceId: ws });
    expect(usage).toEqual({ totalBytes: 123, fileCount: 1 });

    const dl = await svc.download({ userId: 'u1', workspaceId: ws, fileId: 'f1' });
    expect(dl.fileName).toBe('a.txt');
    expect(dl.body.toString()).toBe('hello');

    await svc.delete({ userId: 'u1', workspaceId: ws, fileId: 'f1' });
    expect(prisma.fileAttachment.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }));
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'file.deleted' }));
  });

  it('permission denied: workspace access denied blocks list/upload/usage', async () => {
    wsAuth.requireWorkspaceAccess.mockRejectedValue(new AppError(403, 'FORBIDDEN', 'no access'));
    const prisma = makePrisma();
    const svc = createFileService(prisma as any, makeStorage() as any);
    const ws = '11111111-1111-4111-8111-111111111111';

    await expect(svc.list({ userId: 'u2', workspaceId: ws, limit: 10 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.getUsage({ userId: 'u2', workspaceId: ws })).rejects.toMatchObject({ statusCode: 403 });
    await expect(svc.upload({ userId: 'u2', workspaceId: ws, fileName: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, body: Buffer.from('x') })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('permission denied: cannot delete another user workspace file without admin role', async () => {
    wsAuth.requireWorkspaceAccess.mockResolvedValue({ effectiveRole: 'MEMBER' });
    const prisma = makePrisma();
    prisma.fileAttachment.findFirst.mockResolvedValue({
      id: 'f1', workspaceId: 'w1', projectId: null, taskId: null,
      uploadedById: 'other', fileName: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, storageKey: 'k1',
      createdAt: new Date(), deletedAt: null,
    });
    const svc = createFileService(prisma as any, makeStorage() as any);

    await expect(svc.delete({ userId: 'u1', workspaceId: 'w1', fileId: 'f1' })).rejects.toMatchObject({ statusCode: 403, code: 'FILE_DELETE_FORBIDDEN' });
  });

  it('cross-workspace isolation: file lookup scoped to workspace returns not found for foreign workspace', async () => {
    const prisma = makePrisma();
    // simulate DB scoping: no record for this workspace/file pair
    prisma.fileAttachment.findFirst.mockResolvedValue(null);
    const svc = createFileService(prisma as any, makeStorage() as any);
    const ws = '22222222-2222-4222-8222-222222222222';

    await expect(svc.download({ userId: 'u1', workspaceId: ws, fileId: 'f-foreign' })).rejects.toMatchObject({ statusCode: 404, code: 'FILE_NOT_FOUND' });
    // ensure query is scoped by workspaceId
    expect(prisma.fileAttachment.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'f-foreign', workspaceId: ws, deletedAt: null }),
    }));
  });

  it('project-scoped access: requires project authorization and denies when unauthorized', async () => {
    wsAuth.requireWorkspaceAccess.mockResolvedValue({ effectiveRole: 'MEMBER' });
    projAuth.authorizeProject.mockRejectedValue(new AppError(403, 'PROJECT_FORBIDDEN', 'no project access'));
    const prisma = makePrisma();
    prisma.fileAttachment.findFirst.mockResolvedValue({
      id: 'f1', workspaceId: 'w1', projectId: 'p1', taskId: null,
      uploadedById: 'u1', fileName: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, storageKey: 'k1',
      createdAt: new Date(), deletedAt: null,
    });
    const svc = createFileService(prisma as any, makeStorage() as any);

    await expect(svc.download({ userId: 'u1', workspaceId: 'w1', fileId: 'f1' })).rejects.toMatchObject({ statusCode: 403 });
    expect(projAuth.authorizeProject).toHaveBeenCalled();
  });
});

describe('files module (routes contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET list and GET usage return contract shapes; DELETE returns {ok:true}; GET download streams bytes', async () => {
    const ws = '11111111-1111-4111-8111-111111111111';
    const fid = '33333333-3333-4333-8333-333333333333';
    const service: any = {
      list: vi.fn(async () => ({ items: [{ id: fid, workspaceId: ws, projectId: null, taskId: null, uploadedById: 'u1', fileName: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, createdAt: '2026-01-01T00:00:00Z' }], nextCursor: null, totalBytes: 5 })),
      getUsage: vi.fn(async () => ({ totalBytes: 5, fileCount: 1 })),
      upload: vi.fn(),
      download: vi.fn(async () => ({ body: Buffer.from('hello'), contentType: 'text/plain', fileName: 'a.txt' })),
      delete: vi.fn(async () => undefined),
    };
    const app = express();
    app.use(express.json());
    const router = createFileRouter({ config: { jwtAccessSecret: 'x', jwtAccessExpiresIn: '15m', refreshCookieName: 'r', objectStorageEndpoint: '' } as any, service });
    app.use('/workspaces/:workspaceId/files', router);
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode || 500).json({ success: false, error: { code: err.code || 'ERR', message: err.message } });
    });

    await withServer(app, async (baseUrl) => {
      let res = await fetch(`${baseUrl}/workspaces/${ws}/files?limit=10`);
      let body = await res.json();
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(expect.objectContaining({ items: expect.any(Array), nextCursor: null, totalBytes: 5 }));

      res = await fetch(`${baseUrl}/workspaces/${ws}/files/usage`);
      body = await res.json();
      expect(body.data).toEqual({ totalBytes: 5, fileCount: 1 });

      res = await fetch(`${baseUrl}/workspaces/${ws}/files/${fid}`, { method: 'DELETE' });
      body = await res.json();
      expect(res.status).toBe(200);
      expect(body.data).toEqual({ ok: true });

      res = await fetch(`${baseUrl}/workspaces/${ws}/files/${fid}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(await res.text()).toBe('hello');
    });
  });
});
