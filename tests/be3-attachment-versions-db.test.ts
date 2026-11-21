import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { getPrismaClient } from '../src/db/prisma';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { createFileService } from '../src/modules/files/file.service';
import type { PrivateObjectStorage } from '../src/services/storage/private-object-storage';
import { loadTestConfig } from './helpers/test-config';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';
import {
  CookieJar,
  jsonRequest,
  startServer,
  type JsonResponse,
  type RunningServer,
} from './helpers/test-server';

const DB_FLAG = 'RUN_BE3_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('BE-3 attachment version PostgreSQL tests', () =>
    test('skipped — set RUN_BE3_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

interface TestUser {
  id: string;
  email: string;
  password: string;
  token: string;
  jar: CookieJar;
}

interface UploadedBytes {
  fileName: string;
  mimeType: string;
  body: Buffer;
}

function runTests(rawDbUrl: string): void {
  const tag = `${process.pid}-${Date.now()}`;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];

  let server: RunningServer;
  let baseUrl: string;
  let owner: TestUser;
  let member: TestUser;
  let viewer: TestUser;
  let outsider: TestUser;
  let workspaceId: string;
  let otherWorkspaceId: string;

  // -------------------------------------------------------------------------
  // Fake private object storage: a minimal in-process S3-compatible HTTP
  // server. The real storage adapter (including its size/content-type checks)
  // is exercised end to end; only the network hop is replaced.
  // -------------------------------------------------------------------------
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  let objectServer: Server;
  let objectEndpoint: string;

  function objectKey(requestUrl: string | undefined): string {
    return decodeURIComponent(new URL(requestUrl ?? '/', 'http://localhost').pathname);
  }

  function startObjectStorage(): Promise<string> {
    objectServer = createServer((req, res) => {
      const key = objectKey(req.url);
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
          objects.set(key, {
            body: Buffer.concat(chunks),
            contentType: String(req.headers['content-type'] ?? 'application/octet-stream'),
          });
          res.writeHead(200);
          res.end();
        });
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const object = objects.get(key);
        if (!object) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          'content-type': object.contentType,
          'content-length': String(object.body.length),
        });
        res.end(req.method === 'HEAD' ? undefined : object.body);
        return;
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
    });
    return new Promise((resolve) => {
      objectServer.listen(0, '127.0.0.1', () => {
        const address = objectServer.address();
        if (!address || typeof address === 'string') throw new Error('No object server address');
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Request helpers
  // -------------------------------------------------------------------------
  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });

  const filesUrl = (wsId = workspaceId) => `${baseUrl}/api/v1/workspaces/${wsId}/files`;
  const fileUrl = (fileId: string, wsId = workspaceId) => `${filesUrl(wsId)}/${fileId}`;
  const versionsUrl = (fileId: string, wsId = workspaceId) => `${fileUrl(fileId, wsId)}/versions`;
  const versionUrl = (fileId: string, versionId: string, wsId = workspaceId) =>
    `${versionsUrl(fileId, wsId)}/${versionId}`;

  async function formRequest<T = unknown>(
    url: string,
    options: {
      user: TestUser;
      fields?: Record<string, string>;
      file?: UploadedBytes;
    },
  ): Promise<JsonResponse<T>> {
    const form = new FormData();
    for (const [name, value] of Object.entries(options.fields ?? {})) form.append(name, value);
    if (options.file) {
      form.append(
        'file',
        new Blob([options.file.body], { type: options.file.mimeType }),
        options.file.fileName,
      );
    }
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...auth(options.user) },
      body: form,
    });
    options.user.jar.absorb(response);
    const text = await response.text();
    let body: JsonResponse<T>['body'];
    try {
      body = JSON.parse(text) as JsonResponse<T>['body'];
    } catch {
      body = { success: false, error: { code: 'INVALID_JSON', message: text.slice(0, 200) } };
    }
    return { status: response.status, body, response };
  }

  async function rawGet(url: string, user: TestUser) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${user.token}` } });
    return {
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: Buffer.from(await response.arrayBuffer()),
      response,
    };
  }

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `be3-${suffix}-${tag}@test.example`;
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
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const token = (login.body.data as { accessToken: string }).accessToken;
    userIds.push(user.id);
    return { id: user.id, email, password, token, jar };
  }

  async function addWorkspaceMember(
    user: TestUser,
    targetWorkspaceId = workspaceId,
    role = 'MEMBER',
  ): Promise<void> {
    const res = await jsonRequest(`${baseUrl}/api/v1/workspaces/${targetWorkspaceId}/members`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ email: user.email, role }),
      jar: owner.jar,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  async function createWorkspace(name: string): Promise<string> {
    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name }),
      jar: owner.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = (created.body.data as { id: string }).id;
    workspaceIds.push(id);
    return id;
  }

  async function uploadFile(
    user: TestUser,
    file: UploadedBytes,
    extra: { wsId?: string; fields?: Record<string, string> } = {},
  ) {
    return formRequest<{ id: string; fileName: string; sizeBytes: number }>(
      filesUrl(extra.wsId),
      { user, file, fields: extra.fields },
    );
  }

  async function uploadVersion(
    user: TestUser,
    fileId: string,
    file: UploadedBytes,
    extra: { wsId?: string; fields?: Record<string, string> } = {},
  ) {
    return formRequest<{ version: { id: string; versionNumber: number; isCurrent: boolean } }>(
      versionsUrl(fileId, extra.wsId),
      { user, file, fields: extra.fields },
    );
  }

  before(async () => {
    objectEndpoint = await startObjectStorage();
    const db = await connectTestDatabase(rawDbUrl);
    getPrismaClient(db.url);
    const config = loadTestConfig({
      RATE_LIMIT_NAMESPACE: `be3-db-${tag}`,
      RATE_LIMIT_MAX: '100000',
      AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
      OBJECT_STORAGE_ENDPOINT: objectEndpoint,
      OBJECT_STORAGE_BUCKET: 'be3-test',
      OBJECT_STORAGE_ACCESS_KEY_ID: 'test-key',
      OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret',
    });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;
    await db.prisma.$disconnect();

    owner = await register('BE3 Owner', 'owner');
    member = await register('BE3 Member', 'member');
    viewer = await register('BE3 Viewer', 'viewer');
    outsider = await register('BE3 Outsider', 'outsider');

    workspaceId = await createWorkspace(`BE3 Workspace ${tag}`);
    await addWorkspaceMember(member);
    await addWorkspaceMember(viewer, workspaceId, 'VIEWER');
    otherWorkspaceId = await createWorkspace(`BE3 Other Workspace ${tag}`);
  });

  after(async () => {
    await server?.close();
    await disconnectRedis();
    objectServer?.close();
    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await db.prisma.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
    await db.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await db.prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Core version lifecycle
  // -------------------------------------------------------------------------

  test('upload creates one current v1 and the list/summary use the true byte size', async () => {
    const body = Buffer.from('hello version one');
    const uploaded = await uploadFile(owner, {
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      body,
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const file = uploaded.body.data as { id: string; sizeBytes: number; fileName: string };
    assert.equal(file.sizeBytes, body.byteLength);
    assert.equal(file.fileName, 'notes.txt');

    const listed = await jsonRequest(`${filesUrl()}?limit=100`, { headers: auth(owner) });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const items = (listed.body.data as { items: Array<{ id: string; sizeBytes: number }> }).items;
    const found = items.find((item) => item.id === file.id);
    assert.ok(found);
    assert.equal(found.sizeBytes, body.byteLength);

    const versions = await jsonRequest(versionsUrl(file.id), { headers: auth(owner) });
    assert.equal(versions.status, 200, JSON.stringify(versions.body));
    const vItems = (
      versions.body.data as {
        items: Array<{ versionNumber: number; isCurrent: boolean; sizeBytes: number }>;
      }
    ).items;
    assert.equal(vItems.length, 1);
    assert.equal(vItems[0]?.versionNumber, 1);
    assert.equal(vItems[0]?.isCurrent, true);
    assert.equal(vItems[0]?.sizeBytes, body.byteLength);
  });

  test('a false client-declared size is ignored; the true buffer length is stored', async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const inMemory: PrivateObjectStorage = {
      async put() {},
      async get() {
        return { body: Buffer.alloc(0), contentType: 'text/plain' };
      },
      async delete() {},
      async exists() {
        return true;
      },
    };
    const service = createFileService(db.prisma, inMemory);
    const body = Buffer.from('0123456789'.repeat(10)); // 100 bytes
    const created = await service.upload({
      userId: owner.id,
      workspaceId,
      fileName: 'declared-size.txt',
      mimeType: 'text/plain',
      sizeBytes: 1, // deliberately false
      body,
    });
    await db.prisma.$disconnect();
    assert.equal(created.sizeBytes, body.byteLength);
    assert.equal(created.sizeBytes, 100);
    assert.notEqual(created.sizeBytes, 1);
  });

  // -------------------------------------------------------------------------
  // Permission rules
  // -------------------------------------------------------------------------

  test('outsider gets 403 and wrong-workspace gets 404 on version writes', async () => {
    const uploaded = await uploadFile(owner, {
      fileName: 'perms.txt',
      mimeType: 'text/plain',
      body: Buffer.from('perm test'),
    });
    const fileId = (uploaded.body.data as { id: string }).id;

    const outsiderUpload = await uploadVersion(outsider, fileId, {
      fileName: 'x.txt',
      mimeType: 'text/plain',
      body: Buffer.from('x'),
    });
    assert.equal(outsiderUpload.status, 403, JSON.stringify(outsiderUpload.body));

    // Owner belongs to both workspaces, so workspace access passes and the
    // scoped file lookup fails with 404.
    const wrongWorkspace = await uploadVersion(
      owner,
      fileId,
      { fileName: 'x.txt', mimeType: 'text/plain', body: Buffer.from('x') },
      { wsId: otherWorkspaceId },
    );
    assert.equal(wrongWorkspace.status, 404, JSON.stringify(wrongWorkspace.body));
    assert.equal(wrongWorkspace.body.error?.code, 'FILE_NOT_FOUND');
  });

  test('private project file is hidden with 404 from a non-member workspace member', async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const project = await db.prisma.project.create({
      data: {
        workspaceId,
        name: `BE3 Private ${tag}`,
        key: `BP${Date.now()}`.slice(0, 20),
        visibility: 'PRIVATE',
        ownerId: owner.id,
        status: 'ACTIVE',
      },
    });
    const uploaded = await uploadFile(owner, {
      fileName: 'private.txt',
      mimeType: 'text/plain',
      body: Buffer.from('private'),
    }, { fields: { projectId: project.id } });
    await db.prisma.$disconnect();
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const fileId = (uploaded.body.data as { id: string }).id;

    const hidden = await jsonRequest(versionsUrl(fileId), { headers: auth(member) });
    assert.equal(hidden.status, 404, JSON.stringify(hidden.body));

    const hiddenWrite = await uploadVersion(member, fileId, {
      fileName: 'x.txt',
      mimeType: 'text/plain',
      body: Buffer.from('x'),
    });
    assert.equal(hiddenWrite.status, 404, JSON.stringify(hiddenWrite.body));
  });

  test('viewer gets 403 on version, feedback and make-current writes', async () => {
    const uploaded = await uploadFile(owner, {
      fileName: 'viewer.txt',
      mimeType: 'text/plain',
      body: Buffer.from('viewer'),
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const fileId = (uploaded.body.data as { id: string }).id;
    const versions = await jsonRequest(versionsUrl(fileId), { headers: auth(owner) });
    const versionId = (
      (versions.body.data as { items: Array<{ id: string }> }).items[0] as { id: string }
    ).id;

    const versionWrite = await uploadVersion(viewer, fileId, {
      fileName: 'x.txt',
      mimeType: 'text/plain',
      body: Buffer.from('x'),
    });
    assert.equal(versionWrite.status, 403, JSON.stringify(versionWrite.body));

    const feedbackWrite = await jsonRequest(versionUrl(fileId, versionId) + '/feedback', {
      method: 'POST',
      headers: auth(viewer),
      body: JSON.stringify({ body: 'viewer feedback' }),
    });
    assert.equal(feedbackWrite.status, 403, JSON.stringify(feedbackWrite.body));

    const makeCurrent = await jsonRequest(versionUrl(fileId, versionId) + '/make-current', {
      method: 'POST',
      headers: auth(viewer),
    });
    assert.equal(makeCurrent.status, 403, JSON.stringify(makeCurrent.body));
  });

  // -------------------------------------------------------------------------
  // Concurrency and database constraints
  // -------------------------------------------------------------------------

  test('concurrent version uploads allocate sequential numbers with exactly one current', async () => {
    const uploaded = await uploadFile(owner, {
      fileName: 'concurrent.txt',
      mimeType: 'text/plain',
      body: Buffer.from('v1'),
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const fileId = (uploaded.body.data as { id: string }).id;

    const [first, second] = await Promise.all([
      uploadVersion(owner, fileId, {
        fileName: 'v2.txt',
        mimeType: 'text/plain',
        body: Buffer.from('v2'),
      }),
      uploadVersion(owner, fileId, {
        fileName: 'v3.txt',
        mimeType: 'text/plain',
        body: Buffer.from('v3'),
      }),
    ]);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(second.status, 201, JSON.stringify(second.body));

    const numbers = [
      (first.body.data as { version: { versionNumber: number } }).version.versionNumber,
      (second.body.data as { version: { versionNumber: number } }).version.versionNumber,
    ].sort((a, b) => a - b);
    assert.deepEqual(numbers, [2, 3]);

    const db = await connectTestDatabase(rawDbUrl);
    const current = await db.prisma.attachmentVersion.count({
      where: { attachmentId: fileId, isCurrent: true, deletedAt: null },
    });
    const versions = await db.prisma.attachmentVersion.findMany({
      where: { attachmentId: fileId },
      orderBy: { versionNumber: 'asc' },
    });
    await db.prisma.$disconnect();
    assert.equal(current, 1);
    assert.deepEqual(
      versions.map((version) => version.versionNumber),
      [1, 2, 3],
    );
  });

  test('backfill runs twice and creates exactly one v1 per attachment including soft-deleted rows', async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const migration = readFileSync(
      join(process.cwd(), 'prisma/migrations/20261120140000_be3_attachment_versions/migration.sql'),
      'utf8',
    );
    const backfillSql = migration.slice(migration.indexOf('-- Backfill:'));
    assert.ok(backfillSql.includes('INSERT INTO "AttachmentVersion"'));

    const live = await db.prisma.fileAttachment.create({
      data: {
        workspaceId,
        uploadedById: owner.id,
        fileName: 'backfill-live.txt',
        mimeType: 'text/plain',
        sizeBytes: 3,
        storageKey: `be3-backfill-live-${tag}`,
      },
    });
    const softDeleted = await db.prisma.fileAttachment.create({
      data: {
        workspaceId,
        uploadedById: owner.id,
        fileName: 'backfill-deleted.txt',
        mimeType: 'text/plain',
        sizeBytes: 4,
        storageKey: `be3-backfill-deleted-${tag}`,
        deletedAt: new Date(),
      },
    });

    await db.prisma.$executeRawUnsafe(backfillSql);
    await db.prisma.$executeRawUnsafe(backfillSql);

    const liveVersions = await db.prisma.attachmentVersion.findMany({
      where: { attachmentId: live.id },
    });
    const deletedVersions = await db.prisma.attachmentVersion.findMany({
      where: { attachmentId: softDeleted.id },
    });
    await db.prisma.$disconnect();

    assert.equal(liveVersions.length, 1);
    assert.equal(liveVersions[0]?.versionNumber, 1);
    assert.equal(liveVersions[0]?.isCurrent, true);
    assert.equal(liveVersions[0]?.storageKey, live.storageKey);
    assert.equal(liveVersions[0]?.deletedAt, null);

    assert.equal(deletedVersions.length, 1);
    assert.equal(deletedVersions[0]?.versionNumber, 1);
    assert.equal(deletedVersions[0]?.isCurrent, false);
    assert.equal(deletedVersions[0]?.storageKey, softDeleted.storageKey);
    assert.notEqual(deletedVersions[0]?.deletedAt, null);
  });

  test('partial current index and raw CHECK constraints reject invalid rows', async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const uploaded = await uploadFile(owner, {
      fileName: 'constraints.txt',
      mimeType: 'text/plain',
      body: Buffer.from('constraints'),
    });
    const fileId = (uploaded.body.data as { id: string }).id;

    // A second current live version violates the partial unique index.
    await assert.rejects(
      db.prisma.attachmentVersion.create({
        data: {
          attachmentId: fileId,
          versionNumber: 99,
          isCurrent: true,
          fileName: 'duplicate-current.txt',
          mimeType: 'text/plain',
          sizeBytes: 1,
          storageKey: `be3-dup-current-${tag}`,
          uploadedById: owner.id,
        },
      }),
    );

    // versionNumber must be positive and sizeBytes non-negative.
    await assert.rejects(
      db.prisma.attachmentVersion.create({
        data: {
          attachmentId: fileId,
          versionNumber: 0,
          isCurrent: false,
          fileName: 'bad-number.txt',
          mimeType: 'text/plain',
          sizeBytes: 1,
          storageKey: `be3-bad-number-${tag}`,
          uploadedById: owner.id,
        },
      }),
    );
    await assert.rejects(
      db.prisma.attachmentVersion.create({
        data: {
          attachmentId: fileId,
          versionNumber: 98,
          isCurrent: false,
          fileName: 'bad-size.txt',
          mimeType: 'text/plain',
          sizeBytes: -1,
          storageKey: `be3-bad-size-${tag}`,
          uploadedById: owner.id,
        },
      }),
    );

    const current = await db.prisma.attachmentVersion.findFirstOrThrow({
      where: { attachmentId: fileId, isCurrent: true, deletedAt: null },
    });

    // Feedback body must be non-blank and at most 4000 characters.
    await assert.rejects(
      db.prisma.attachmentVersionFeedback.create({
        data: { attachmentVersionId: current.id, authorId: owner.id, body: '   ' },
      }),
    );
    await assert.rejects(
      db.prisma.attachmentVersionFeedback.create({
        data: { attachmentVersionId: current.id, authorId: owner.id, body: 'x'.repeat(4001) },
      }),
    );
    await db.prisma.$disconnect();
  });

  // -------------------------------------------------------------------------
  // Delete, promote, make-current
  // -------------------------------------------------------------------------

  test('deleting the last live version returns 409 LAST_VERSION', async () => {
    const uploaded = await uploadFile(owner, {
      fileName: 'last.txt',
      mimeType: 'text/plain',
      body: Buffer.from('only'),
    });
    const fileId = (uploaded.body.data as { id: string }).id;
    const versions = await jsonRequest(versionsUrl(fileId), { headers: auth(owner) });
    const versionId = (
      (versions.body.data as { items: Array<{ id: string }> }).items[0] as { id: string }
    ).id;

    const deleted = await jsonRequest(versionUrl(fileId, versionId), {
      method: 'DELETE',
      headers: auth(owner),
    });
    assert.equal(deleted.status, 409, JSON.stringify(deleted.body));
    assert.equal(deleted.body.error?.code, 'LAST_VERSION');
  });

  test('deleting the current version promotes the previous and syncs attachment metadata', async () => {
    const uploaded = await uploadFile(owner, {
      fileName: 'v1.txt',
      mimeType: 'text/plain',
      body: Buffer.from('first'),
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    const fileId = (uploaded.body.data as { id: string }).id;
    const second = await uploadVersion(owner, fileId, {
      fileName: 'v2.txt',
      mimeType: 'text/plain',
      body: Buffer.from('second'),
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const currentId = (second.body.data as { version: { id: string } }).version.id;

    const deleted = await jsonRequest(versionUrl(fileId, currentId), {
      method: 'DELETE',
      headers: auth(owner),
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    assert.deepEqual(deleted.body.data, { ok: true });

    const versions = await jsonRequest(versionsUrl(fileId), { headers: auth(owner) });
    const items = (versions.body.data as { items: Array<{ versionNumber: number; isCurrent: boolean; fileName: string }> }).items;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.versionNumber, 1);
    assert.equal(items[0]?.isCurrent, true);
    assert.equal(items[0]?.fileName, 'v1.txt');

    const listed = await jsonRequest(`${filesUrl()}?limit=100`, { headers: auth(owner) });
    const summary = (listed.body.data as { items: Array<{ id: string; fileName: string; sizeBytes: number }> }).items.find((item) => item.id === fileId);
    assert.ok(summary);
    assert.equal(summary.fileName, 'v1.txt');
    assert.equal(summary.sizeBytes, Buffer.from('first').byteLength);
  });

  test('make-current keeps ids and storage keys, updates list metadata, and is a no-op when already current', async () => {
    const uploaded = await uploadFile(owner, {
      fileName: 'old.txt',
      mimeType: 'text/plain',
      body: Buffer.from('olddata'),
    });
    const fileId = (uploaded.body.data as { id: string }).id;
    const second = await uploadVersion(owner, fileId, {
      fileName: 'new.txt',
      mimeType: 'text/plain',
      body: Buffer.from('new data here'),
    });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    const v2 = (second.body.data as { version: { id: string } }).version;

    const db = await connectTestDatabase(rawDbUrl);
    const before = await db.prisma.attachmentVersion.findMany({
      where: { attachmentId: fileId },
      orderBy: { versionNumber: 'asc' },
    });
    await db.prisma.$disconnect();

    const v1 = before.find((version) => version.versionNumber === 1)!;
    const made = await jsonRequest(versionUrl(fileId, v1.id) + '/make-current', {
      method: 'POST',
      headers: auth(owner),
    });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal((made.body.data as { version: { isCurrent: boolean } }).version.isCurrent, true);

    const listed = await jsonRequest(`${filesUrl()}?limit=100`, { headers: auth(owner) });
    const summary = (listed.body.data as { items: Array<{ id: string; fileName: string; sizeBytes: number }> }).items.find((item) => item.id === fileId);
    assert.ok(summary);
    assert.equal(summary.fileName, 'old.txt');
    assert.equal(summary.sizeBytes, Buffer.from('olddata').byteLength);

    const dbAfter = await connectTestDatabase(rawDbUrl);
    const after = await dbAfter.prisma.attachmentVersion.findMany({
      where: { attachmentId: fileId },
      orderBy: { versionNumber: 'asc' },
    });
    await dbAfter.prisma.$disconnect();
    assert.deepEqual(after.map((v) => v.id), before.map((v) => v.id));
    assert.deepEqual(after.map((v) => v.storageKey), before.map((v) => v.storageKey));
    assert.equal(after.find((v) => v.id === v2.id)?.isCurrent, false);
    assert.equal(after.find((v) => v.id === v1.id)?.isCurrent, true);

    const again = await jsonRequest(versionUrl(fileId, v1.id) + '/make-current', {
      method: 'POST',
      headers: auth(owner),
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
  });

  // -------------------------------------------------------------------------
  // Downloads (the >2 MB / plain-text regression)
  // -------------------------------------------------------------------------

  test('plain GET and version download serve plain text and a >2 MB PDF with correct content type', async () => {
    const text = await uploadFile(owner, {
      fileName: 'plain.txt',
      mimeType: 'text/plain',
      body: Buffer.from('plain text download'),
    });
    const textId = (text.body.data as { id: string }).id;

    const textDownload = await rawGet(fileUrl(textId), owner);
    assert.equal(textDownload.status, 200);
    assert.equal(textDownload.contentType, 'text/plain');
    assert.equal(textDownload.body.toString(), 'plain text download');

    const largeBody = Buffer.alloc(2 * 1024 * 1024 + 4096, 0x41);
    const pdf = await uploadFile(owner, {
      fileName: 'large.pdf',
      mimeType: 'application/pdf',
      body: largeBody,
    });
    assert.equal(pdf.status, 201, JSON.stringify(pdf.body));
    const pdfId = (pdf.body.data as { id: string }).id;
    assert.equal((pdf.body.data as { sizeBytes: number }).sizeBytes, largeBody.byteLength);

    const pdfDownload = await rawGet(fileUrl(pdfId), owner);
    assert.equal(pdfDownload.status, 200);
    assert.equal(pdfDownload.contentType, 'application/pdf');
    assert.equal(pdfDownload.body.byteLength, largeBody.byteLength);

    const versions = await jsonRequest(versionsUrl(pdfId), { headers: auth(owner) });
    const versionId = (
      (versions.body.data as { items: Array<{ id: string }> }).items[0] as { id: string }
    ).id;
    const versionDownload = await rawGet(versionUrl(pdfId, versionId) + '/download', owner);
    assert.equal(versionDownload.status, 200);
    assert.equal(versionDownload.body.byteLength, largeBody.byteLength);
  });

  test('plain GET returns 404 FILE_VERSION_NOT_FOUND when no live current version exists', async () => {
    const db = await connectTestDatabase(rawDbUrl);
    const attachment = await db.prisma.fileAttachment.create({
      data: {
        workspaceId,
        uploadedById: owner.id,
        fileName: 'no-version.txt',
        mimeType: 'text/plain',
        sizeBytes: 1,
        storageKey: `be3-no-version-${tag}`,
      },
    });
    await db.prisma.$disconnect();

    const result = await rawGet(fileUrl(attachment.id), owner);
    assert.equal(result.status, 404);
  });

  // -------------------------------------------------------------------------
  // Feedback
  // -------------------------------------------------------------------------

  test('feedback CRUD enforces authorship, visibility and soft-delete 404s', async () => {
    const uploaded = await uploadFile(owner, {
      fileName: 'feedback.txt',
      mimeType: 'text/plain',
      body: Buffer.from('feedback'),
    });
    const fileId = (uploaded.body.data as { id: string }).id;
    const createdVersion = await uploadVersion(owner, fileId, {
      fileName: 'feedback-v2.txt',
      mimeType: 'text/plain',
      body: Buffer.from('feedback v2'),
    });
    const versionId = (createdVersion.body.data as { version: { id: string } }).version.id;

    const created = await jsonRequest(versionUrl(fileId, versionId) + '/feedback', {
      method: 'POST',
      headers: auth(member),
      body: JSON.stringify({ body: 'Looks good' }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const feedbackId = (created.body.data as { feedback: { id: string } }).feedback.id;

    const list = await jsonRequest(versionUrl(fileId, versionId) + '/feedback', {
      headers: auth(owner),
    });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const items = (list.body.data as { items: Array<{ id: string; body: string }> }).items;
    assert.ok(items.some((item) => item.id === feedbackId && item.body === 'Looks good'));

    const foreignEdit = await jsonRequest(
      versionUrl(fileId, versionId) + '/feedback/' + feedbackId,
      {
        method: 'PATCH',
        headers: auth(owner),
        body: JSON.stringify({ body: 'Not allowed' }),
      },
    );
    assert.equal(foreignEdit.status, 403, JSON.stringify(foreignEdit.body));

    const authorEdit = await jsonRequest(
      versionUrl(fileId, versionId) + '/feedback/' + feedbackId,
      {
        method: 'PATCH',
        headers: auth(member),
        body: JSON.stringify({ body: 'Updated feedback' }),
      },
    );
    assert.equal(authorEdit.status, 200, JSON.stringify(authorEdit.body));
    assert.equal(
      (authorEdit.body.data as { feedback: { body: string; editedAt: string | null } }).feedback.body,
      'Updated feedback',
    );
    assert.notEqual(
      (authorEdit.body.data as { feedback: { editedAt: string | null } }).feedback.editedAt,
      null,
    );

    const deleted = await jsonRequest(
      versionUrl(fileId, versionId) + '/feedback/' + feedbackId,
      { method: 'DELETE', headers: auth(member) },
    );
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));

    const afterDelete = await jsonRequest(versionUrl(fileId, versionId) + '/feedback', {
      headers: auth(owner),
    });
    const remaining = (afterDelete.body.data as { items: Array<{ id: string }> }).items;
    assert.equal(remaining.some((item) => item.id === feedbackId), false);

    // Soft-deleting the version hides its feedback with 404.
    const db = await connectTestDatabase(rawDbUrl);
    await db.prisma.attachmentVersion.update({
      where: { id: versionId },
      data: { deletedAt: new Date(), isCurrent: false },
    });
    await db.prisma.$disconnect();
    const hidden = await jsonRequest(versionUrl(fileId, versionId) + '/feedback', {
      headers: auth(owner),
    });
    assert.equal(hidden.status, 404, JSON.stringify(hidden.body));
  });
}
