/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../utils/errors';

const authz = vi.hoisted(() => ({
  requireWorkspaceAccess: vi.fn(),
  authorizeProject: vi.fn(),
  getProjectAuthorization: vi.fn(),
  WorkspaceCapability: { ViewWorkspace: 'workspace:view' },
  ProjectPermission: {
    View: 'project.view',
    FileUpload: 'file.upload',
    FileDeleteOwn: 'file.delete.own',
    FileDeleteAny: 'file.delete.any',
  },
}));
const audit = vi.hoisted(() => ({ recordAuditEvent: vi.fn(async () => undefined) }));

vi.mock('../authorization', () => authz);
vi.mock('../../services/audit', () => audit);

import { createResourceService } from './resource.service';

function makeStorage() {
  return {
    put: vi.fn(async () => undefined),
    get: vi.fn(async (_key: string, _opts?: any) => ({ body: Buffer.from('hello'), contentType: 'text/plain' })),
    delete: vi.fn(async () => undefined),
  };
}

function makePrisma(seed: any = {}) {
  let folderSeq = 1;
  let fileSeq = 1;
  let bookmarkSeq = 1;
  const folders: any[] = seed.folders ?? [];
  const files: any[] = seed.files ?? [];
  const bookmarks: any[] = seed.bookmarks ?? [];

  function matchFolder(where: any, f: any) {
    if (where.id && f.id !== where.id) return false;
    if (where.workspaceId && f.workspaceId !== where.workspaceId) return false;
    if (Object.prototype.hasOwnProperty.call(where, 'projectId') && f.projectId !== where.projectId) return false;
    if (Object.prototype.hasOwnProperty.call(where, 'parentId') && f.parentId !== where.parentId) return false;
    if (where.name && f.name !== where.name) return false;
    return true;
  }
  function matchFile(where: any, f: any) {
    if (where.id && f.id !== where.id) return false;
    if (where.workspaceId && f.workspaceId !== where.workspaceId) return false;
    if (Object.prototype.hasOwnProperty.call(where, 'projectId') && f.projectId !== where.projectId) return false;
    if (Object.prototype.hasOwnProperty.call(where, 'folderId') && f.folderId !== where.folderId) return false;
    if (Object.prototype.hasOwnProperty.call(where, 'deletedAt') && where.deletedAt === null && f.deletedAt !== null) return false;
    return true;
  }

  const prisma: any = {
    resourceFolder: {
      findFirst: vi.fn(async ({ where }: any) => folders.find((f) => matchFolder(where, f)) ?? null),
      findUnique: vi.fn(async ({ where, select }: any) => {
        const f = folders.find((x) => x.id === where.id) ?? null;
        if (!f) return null;
        if (!select) return f;
        const out: any = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = f[k];
        return out;
      }),
      findMany: vi.fn(async ({ where }: any) => folders.filter((f) => matchFolder(where ?? {}, f))),
      create: vi.fn(async ({ data }: any) => {
        const dup = folders.find((f) => f.workspaceId === data.workspaceId && f.projectId === data.projectId && f.parentId === data.parentId && f.name === data.name);
        if (dup) { const e: any = new Error('Unique'); e.code = 'P2002'; throw e; }
        const row = { id: data.id ?? `folder-${folderSeq++}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        folders.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const idx = folders.findIndex((f) => f.id === where.id);
        if (idx < 0) throw new Error('not found');
        const next = { ...folders[idx], ...data, updatedAt: new Date() };
        if (Object.prototype.hasOwnProperty.call(data, 'parentId') || Object.prototype.hasOwnProperty.call(data, 'name')) {
          const dup = folders.find((f, i) => i !== idx && f.workspaceId === next.workspaceId && f.projectId === next.projectId && f.parentId === next.parentId && f.name === next.name);
          if (dup) { const e: any = new Error('Unique'); e.code = 'P2002'; throw e; }
        }
        folders[idx] = next;
        return next;
      }),
      delete: vi.fn(async ({ where }: any) => {
        const idx = folders.findIndex((f) => f.id === where.id);
        if (idx >= 0) folders.splice(idx, 1);
        return {};
      }),
    },
    resourceFile: {
      findFirst: vi.fn(async ({ where }: any) => files.find((f) => matchFile(where, f)) ?? null),
      findMany: vi.fn(async ({ where }: any) => files.filter((f) => matchFile(where ?? {}, f))),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: data.id ?? `file-${fileSeq++}`, createdAt: new Date(), deletedAt: data.deletedAt ?? null, ...data };
        files.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const idx = files.findIndex((f) => f.id === where.id);
        if (idx < 0) throw new Error('not found');
        files[idx] = { ...files[idx], ...data };
        return files[idx];
      }),
      count: vi.fn(async ({ where }: any) => files.filter((f) => matchFile(where ?? {}, f)).length),
    },
    resourceBookmark: {
      findMany: vi.fn(async () => bookmarks),
      findFirst: vi.fn(async ({ where }: any) => bookmarks.find((b) => b.id === where.id) ?? null),
      create: vi.fn(async ({ data }: any) => { const r = { id: `bm-${bookmarkSeq++}`, createdAt: new Date(), ...data }; bookmarks.push(r); return r; }),
      update: vi.fn(async ({ where, data }: any) => { const i = bookmarks.findIndex((b) => b.id === where.id); bookmarks[i] = { ...bookmarks[i], ...data }; return bookmarks[i]; }),
      delete: vi.fn(async ({ where }: any) => { const i = bookmarks.findIndex((b) => b.id === where.id); if (i >= 0) bookmarks.splice(i, 1); return {}; }),
    },
    resourceRecentItem: { upsert: vi.fn(), findMany: vi.fn(async () => []), deleteMany: vi.fn() },
    resourceDashboardPreference: { findUnique: vi.fn(), upsert: vi.fn() },
    taskDocument: { findMany: vi.fn(async () => []) },
    task: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma, folders, files, bookmarks };
}

describe('resources module (service)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authz.requireWorkspaceAccess.mockResolvedValue({ effectiveRole: 'MEMBER' });
    authz.authorizeProject.mockResolvedValue({});
    authz.getProjectAuthorization.mockResolvedValue({ permissions: [authz.ProjectPermission.FileDeleteOwn, authz.ProjectPermission.FileDeleteAny, authz.ProjectPermission.FileUpload] });
  });

  it('cross-workspace access denied: listing folders in another workspace is forbidden/denied', async () => {
    authz.requireWorkspaceAccess.mockRejectedValue(new AppError(403, 'WORKSPACE_ACCESS_DENIED', 'denied'));
    const { prisma } = makePrisma();
    const svc = createResourceService(prisma as any, makeStorage() as any);
    await expect(svc.listFolders({ userId: 'u1', workspaceId: 'w-other', projectId: null, parentId: null }))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('path traversal rejected in folder batch upload', async () => {
    const { prisma } = makePrisma();
    const svc = createResourceService(prisma as any, makeStorage() as any);
    await expect(svc.uploadFolderBatch({
      userId: 'u1', workspaceId: 'w1', projectId: null, parentFolderId: null,
      files: [{ relativePath: '../evil.txt', fileName: 'evil.txt', mimeType: 'text/plain', sizeBytes: 4, body: Buffer.from('evil') }],
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_PATH' });

    await expect(svc.uploadFolderBatch({
      userId: 'u1', workspaceId: 'w1', projectId: null, parentFolderId: null,
      files: [{ relativePath: '/abs/path.txt', fileName: 'path.txt', mimeType: 'text/plain', sizeBytes: 4, body: Buffer.from('evil') }],
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_PATH' });

    await expect(svc.uploadFolderBatch({
      userId: 'u1', workspaceId: 'w1', projectId: null, parentFolderId: null,
      files: [{ relativePath: 'dir\\file.txt', fileName: 'file.txt', mimeType: 'text/plain', sizeBytes: 4, body: Buffer.from('evil') }],
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_PATH' });
  });

  it('duplicate folder name rejected in same location', async () => {
    const { prisma } = makePrisma();
    const svc = createResourceService(prisma as any, makeStorage() as any);
    await svc.createFolder({ userId: 'u1', workspaceId: 'w1', projectId: null, parentId: null, name: 'Docs' });
    await expect(svc.createFolder({ userId: 'u1', workspaceId: 'w1', projectId: null, parentId: null, name: 'Docs' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_FOLDER_NAME_CONFLICT' });
  });

  it('folder move into its own descendant is rejected', async () => {
    const { prisma, folders } = makePrisma({
      folders: [
        { id: 'A', workspaceId: 'w1', projectId: null, parentId: null, name: 'A', createdById: 'u1' },
        { id: 'B', workspaceId: 'w1', projectId: null, parentId: 'A', name: 'B', createdById: 'u1' },
        { id: 'C', workspaceId: 'w1', projectId: null, parentId: 'B', name: 'C', createdById: 'u1' },
      ],
    });
    const svc = createResourceService(prisma as any, makeStorage() as any);
    await expect(svc.moveFolder({ userId: 'u1', workspaceId: 'w1', projectId: null, folderId: 'A', parentId: 'C' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_FOLDER_MOVE' });
    // sanity: folders unchanged
    expect(folders.find((f: any) => f.id === 'A')?.parentId).toBeNull();
  });

  it('viewer cannot upload (project-scoped requires editor/upload permission)', async () => {
    authz.authorizeProject.mockRejectedValue(new AppError(403, 'INSUFFICIENT_PROJECT_ROLE', 'nope'));
    const { prisma } = makePrisma();
    const svc = createResourceService(prisma as any, makeStorage() as any);
    await expect(svc.uploadFile({
      userId: 'viewer', workspaceId: 'w1', projectId: 'p1', folderId: null,
      fileName: 'note.txt', mimeType: 'text/plain', sizeBytes: 4, body: Buffer.from('test'),
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('soft-deleted file is not listed and not downloadable', async () => {
    const { prisma } = makePrisma({
      files: [
        { id: 'f1', workspaceId: 'w1', projectId: null, folderId: null, name: 'live.txt', mimeType: 'text/plain', sizeBytes: 1, storageKey: 'k1', uploadedById: 'u1', createdAt: new Date(), deletedAt: null },
        { id: 'f2', workspaceId: 'w1', projectId: null, folderId: null, name: 'gone.txt', mimeType: 'text/plain', sizeBytes: 1, storageKey: 'k2', uploadedById: 'u1', createdAt: new Date(), deletedAt: new Date() },
      ],
    });
    const svc = createResourceService(prisma as any, makeStorage() as any);
    const listed = await svc.listFiles({ userId: 'u1', workspaceId: 'w1', projectId: null, folderId: null, limit: 25 });
    expect(listed.items.map((f: any) => f.id)).toEqual(['f1']);
    await expect(svc.downloadFile({ userId: 'u1', workspaceId: 'w1', projectId: null, fileId: 'f2' }))
      .rejects.toMatchObject({ statusCode: 404, code: 'RESOURCE_FILE_NOT_FOUND' });
  });

  it('folder-batch upload creates the right folder tree and stores files in correct folders', async () => {
    const storage = makeStorage();
    const { prisma, folders, files } = makePrisma();
    const svc = createResourceService(prisma as any, storage as any);
    const result = await svc.uploadFolderBatch({
      userId: 'u1', workspaceId: 'w1', projectId: null, parentFolderId: null,
      files: [
        { relativePath: 'design/logos/a.txt', fileName: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, body: Buffer.from('a') },
        { relativePath: 'design/b.txt', fileName: 'b.txt', mimeType: 'text/plain', sizeBytes: 1, body: Buffer.from('b') },
        { relativePath: 'c.txt', fileName: 'c.txt', mimeType: 'text/plain', sizeBytes: 1, body: Buffer.from('c') },
      ],
    });

    expect(result.files).toHaveLength(3);
    expect(result.createdFoldersCount).toBe(2); // design, design/logos
    const design = folders.find((f: any) => f.name === 'design' && f.parentId === null);
    const logos = folders.find((f: any) => f.name === 'logos' && f.parentId === design?.id);
    expect(design).toBeTruthy();
    expect(logos).toBeTruthy();
    const a = files.find((f: any) => f.name === 'a.txt');
    const b = files.find((f: any) => f.name === 'b.txt');
    const c = files.find((f: any) => f.name === 'c.txt');
    expect(a.folderId).toBe(logos.id);
    expect(b.folderId).toBe(design.id);
    expect(c.folderId).toBeNull();
    expect(storage.put).toHaveBeenCalledTimes(3);
  });
});
