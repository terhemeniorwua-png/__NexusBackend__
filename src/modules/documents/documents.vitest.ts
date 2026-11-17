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
  ProjectCapability: { ViewFiles: 'project.files.view', ManageFiles: 'project.files.manage' },
}));
const visibility = vi.hoisted(() => ({
  projectVisibleToUser: vi.fn(() => ({ OR: [{ visibility: 'WORKSPACE' }] })),
}));
const audit = vi.hoisted(() => ({ recordAuditEvent: vi.fn(async () => undefined) }));

vi.mock('../workspaces/authorization', () => wsAuth);
vi.mock('../authorization/project.policy', () => projAuth);
vi.mock('../projects/project-visibility', () => visibility);
vi.mock('../../services/audit', () => audit);
vi.mock('../../middleware/authenticate', () => ({
  createRequireAuth: () => (req: any, _res: any, next: any) => {
    req.auth = { userId: 'u1', sessionId: 's1', email: 'u1@test', name: 'U1', status: 'ACTIVE' };
    next();
  },
  createRequireActiveAccount: () => (_req: any, _res: any, next: any) => next(),
}));

import { createDocumentService } from './document.service';
import { createDocumentRouter } from './document.routes';
import { AppError } from '../../utils/errors';

function makePrisma() {
  const now = new Date('2026-01-01T00:00:00Z');
  const base: any = {
    document: {
      create: vi.fn(async ({ data }: any) => ({
        id: 'd1', ...data, createdAt: now, updatedAt: now, deletedAt: null,
        author: { name: 'Alice' }, _count: { revisions: 0, comments: 0 },
      })),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(async ({ data }: any) => ({
        id: 'd1', workspaceId: 'w1', projectId: null, taskId: null, title: data.title ?? 'Doc',
        content: data.content ?? '', authorId: 'u1', createdAt: now, updatedAt: new Date('2026-01-02T00:00:00Z'), deletedAt: null,
        author: { name: 'Alice' }, _count: { revisions: 1, comments: 0 },
      })),
    },
    documentRevision: {
      create: vi.fn(async () => ({ id: 'r1' })),
      findMany: vi.fn(async () => [{ id: 'r1', authorId: 'u1', content: 'old', createdAt: now, author: { name: 'Alice' } }]),
    },
    documentComment: {
      create: vi.fn(async ({ data }: any) => ({
        id: 'c1', ...data, editedAt: null, deletedAt: null, createdAt: now, updatedAt: now, author: { name: 'Alice' },
      })),
      findMany: vi.fn(async () => [{ id: 'c1', documentId: 'd1', authorId: 'u1', body: 'hi', editedAt: null, createdAt: now, author: { name: 'Alice' } }]),
      findFirst: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    task: { findFirst: vi.fn() },
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

describe('documents module (service)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wsAuth.requireWorkspaceAccess.mockResolvedValue({ effectiveRole: 'MEMBER', membership: { organizationRole: null } });
    projAuth.requireProjectAccess.mockResolvedValue({});
  });

  it('happy path: create, list (cursor), get, update, revisions, comments, delete (workspace doc)', async () => {
    const prisma = makePrisma();
    const now = new Date('2026-01-01T00:00:00Z');
    const docRow = { id: 'd1', workspaceId: 'w1', projectId: null, taskId: null, title: 'Doc', content: 'hi', authorId: 'u1', createdAt: now, updatedAt: now, deletedAt: null, author: { name: 'Alice' }, _count: { revisions: 0, comments: 0 } };
    prisma.document.findMany.mockResolvedValue([docRow, { ...docRow, id: 'd0' }]);
    prisma.document.findFirst.mockResolvedValue(docRow);
    prisma.documentComment.findFirst.mockResolvedValue({ id: 'c1', documentId: 'd1', authorId: 'u1', deletedAt: null });

    const svc = createDocumentService(prisma as any);

    const created = await svc.create({ userId: 'u1', workspaceId: 'w1', title: 'Doc', content: 'hi' });
    expect(created.id).toBe('d1');
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'document.created' }));

    const listed = await svc.list({ userId: 'u1', workspaceId: 'w1', limit: 1 });
    expect(listed.items).toHaveLength(1);
    expect(listed.nextCursor).toBe('d1');

    const got = await svc.get({ userId: 'u1', workspaceId: 'w1', documentId: 'd1' });
    expect(got.title).toBe('Doc');

    const updated = await svc.update({ userId: 'u1', workspaceId: 'w1', documentId: 'd1', content: 'new' });
    expect(updated.authorName).toBe('Alice');
    expect(prisma.documentRevision.create).toHaveBeenCalled();
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'document.updated' }));

    const revs = await svc.listRevisions({ userId: 'u1', workspaceId: 'w1', documentId: 'd1' });
    expect(revs[0]).toEqual(expect.objectContaining({ id: 'r1', authorName: 'Alice', content: 'old' }));

    const comment = await svc.addComment({ userId: 'u1', workspaceId: 'w1', documentId: 'd1', body: 'hi' });
    expect(comment.body).toBe('hi');
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'document.comment_created' }));

    const comments = await svc.listComments({ userId: 'u1', workspaceId: 'w1', documentId: 'd1' });
    expect(comments).toHaveLength(1);

    await svc.deleteComment({ userId: 'u1', workspaceId: 'w1', documentId: 'd1', commentId: 'c1' });
    expect(prisma.documentComment.update).toHaveBeenCalled();
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'document.comment_deleted' }));

    await svc.delete({ userId: 'u1', workspaceId: 'w1', documentId: 'd1' });
    expect(prisma.document.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }));
    expect(audit.recordAuditEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'document.deleted' }));
  });

  it('permission denied: workspace access denied and non-owner/member cannot edit/delete workspace doc', async () => {
    const prisma = makePrisma();
    const svc = createDocumentService(prisma as any);
    wsAuth.requireWorkspaceAccess.mockRejectedValue(new AppError(403, 'FORBIDDEN', 'no access'));
    await expect(svc.list({ userId: 'u2', workspaceId: 'w1', limit: 10 })).rejects.toMatchObject({ statusCode: 403 });

    wsAuth.requireWorkspaceAccess.mockResolvedValue({ effectiveRole: 'MEMBER', membership: { organizationRole: null } });
    const now = new Date();
    prisma.document.findFirst.mockResolvedValue({ id: 'd1', workspaceId: 'w1', projectId: null, taskId: null, title: 'Doc', content: 'x', authorId: 'owner', createdAt: now, updatedAt: now, deletedAt: null });
    await expect(svc.update({ userId: 'u2', workspaceId: 'w1', documentId: 'd1', title: 'x' })).rejects.toMatchObject({ statusCode: 403, code: 'DOCUMENT_EDIT_FORBIDDEN' });
    await expect(svc.delete({ userId: 'u2', workspaceId: 'w1', documentId: 'd1' })).rejects.toMatchObject({ statusCode: 403, code: 'DOCUMENT_DELETE_FORBIDDEN' });
  });

  it('cross-workspace isolation: foreign workspace document not found / scoped queries', async () => {
    const prisma = makePrisma();
    prisma.document.findFirst.mockResolvedValue(null);
    const svc = createDocumentService(prisma as any);

    await expect(svc.get({ userId: 'u1', workspaceId: 'w-foreign', documentId: 'd1' })).rejects.toMatchObject({ statusCode: 404, code: 'DOCUMENT_NOT_FOUND' });
    expect(prisma.document.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'd1', workspaceId: 'w-foreign', deletedAt: null }),
    }));
  });
});

describe('documents module (routes contract)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes return contract shapes including cursor list and {ok:true} deletes', async () => {
    const ws = '11111111-1111-4111-8111-111111111111';
    const did = '22222222-2222-4222-8222-222222222222';
    const cid = '33333333-3333-4333-8333-333333333333';
    const doc = { id: did, workspaceId: ws, projectId: null, taskId: null, title: 'T', content: '', authorId: 'u1', authorName: 'A', revisionCount: 0, commentCount: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    const service: any = {
      list: vi.fn(async () => ({ items: [doc], nextCursor: null })),
      create: vi.fn(async () => doc),
      get: vi.fn(async () => doc),
      update: vi.fn(async () => doc),
      delete: vi.fn(async () => undefined),
      listRevisions: vi.fn(async () => [{ id: 'r1', authorId: 'u1', authorName: 'A', content: 'x', createdAt: '2026-01-01T00:00:00Z' }]),
      listComments: vi.fn(async () => [{ id: cid, documentId: did, authorId: 'u1', authorName: 'A', body: 'b', editedAt: null, createdAt: '2026-01-01T00:00:00Z' }]),
      addComment: vi.fn(async () => ({ id: cid, documentId: did, authorId: 'u1', authorName: 'A', body: 'b', editedAt: null, createdAt: '2026-01-01T00:00:00Z' })),
      deleteComment: vi.fn(async () => undefined),
    };
    const app = express();
    app.use(express.json());
    app.use('/workspaces/:workspaceId/documents', createDocumentRouter({ config: {} as any, service }));
     
    app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode || 500).json({ success: false, error: { code: err.code || 'ERR', message: err.message } }));

    await withServer(app, async (baseUrl) => {
      let res = await fetch(`${baseUrl}/workspaces/${ws}/documents?limit=10`);
      let body = await res.json();
      expect(body.data).toEqual({ items: [doc], nextCursor: null });

      res = await fetch(`${baseUrl}/workspaces/${ws}/documents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'T' }) });
      expect(res.status).toBe(201);
      body = await res.json();
      expect(body.data.id).toBe(did);

      res = await fetch(`${baseUrl}/workspaces/${ws}/documents/${did}`);
      body = await res.json();
      expect(body.data.title).toBe('T');

      res = await fetch(`${baseUrl}/workspaces/${ws}/documents/${did}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'T2' }) });
      body = await res.json();
      expect(body.data.id).toBe(did);

      res = await fetch(`${baseUrl}/workspaces/${ws}/documents/${did}/revisions`);
      body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data[0].content).toBe('x');

      res = await fetch(`${baseUrl}/workspaces/${ws}/documents/${did}/comments`);
      body = await res.json();
      expect(body.data[0].body).toBe('b');

      res = await fetch(`${baseUrl}/workspaces/${ws}/documents/${did}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: 'b' }) });
      expect(res.status).toBe(201);

      res = await fetch(`${baseUrl}/workspaces/${ws}/documents/${did}/comments/${cid}`, { method: 'DELETE' });
      body = await res.json();
      expect(body.data).toEqual({ ok: true });

      res = await fetch(`${baseUrl}/workspaces/${ws}/documents/${did}`, { method: 'DELETE' });
      body = await res.json();
      expect(body.data).toEqual({ ok: true });
    });
  });
});
