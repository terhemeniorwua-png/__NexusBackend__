import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { createSearchService } from '../src/modules/search/search.service';
import { connectTestDatabase, resolveTestDatabaseUrl } from './helpers/test-database';

const DB_FLAG = 'RUN_PHASE18_DB_TESTS';
let databaseUrl: string | null = null;
let skipReason = 'Set RUN_PHASE18_DB_TESTS=true and an explicit loopback TEST_DATABASE_URL';
try {
  databaseUrl = resolveTestDatabaseUrl(DB_FLAG);
  if (databaseUrl) skipReason = '';
} catch (error) {
  if (process.env[DB_FLAG] === 'true') throw error;
  skipReason = error instanceof Error ? error.message : 'The test database identity was rejected';
}

describe('Phase 18 search database integration', { skip: skipReason || false }, () => {
  let prisma: PrismaClient;
  let service: ReturnType<typeof createSearchService>;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  let ownerId = '';
  let memberId = '';
  let outsiderId = '';
  let workspaceId = '';
  let privateProjectId = '';
  let publicProjectId = '';
  let privateDocumentId = '';
  let publicDocumentId = '';
  let privateFileId = '';
  let publicFileId = '';
  let privateChannelId = '';
  let publicChannelId = '';
  let privateMessageId = '';
  let publicMessageId = '';
  let privateTaskId = '';
  let publicTaskId = '';
  const needle = `qzx${process.pid}${Date.now()}`;

  before(async () => {
    const database = await connectTestDatabase(databaseUrl as string);
    prisma = database.prisma;
    service = createSearchService(prisma);
    const suffix = `${process.pid}-${Date.now()}`;

    const owner = await prisma.user.create({
      data: {
        email: `search-owner-${suffix}@example.test`,
        name: `Owner ${needle}`,
        passwordHash: 'x',
        status: 'ACTIVE',
      },
    });
    const member = await prisma.user.create({
      data: {
        email: `search-member-${suffix}@example.test`,
        name: `Member ${needle}`,
        passwordHash: 'x',
        status: 'ACTIVE',
      },
    });
    const outsider = await prisma.user.create({
      data: {
        email: `search-outsider-${suffix}@example.test`,
        name: `Outsider ${needle}`,
        passwordHash: 'x',
        status: 'ACTIVE',
      },
    });
    ownerId = owner.id;
    memberId = member.id;
    outsiderId = outsider.id;
    userIds.push(owner.id, member.id, outsider.id);

    const workspace = await prisma.workspace.create({
      data: { name: `Workspace ${needle}`, slug: `search-${suffix}`, ownerId: owner.id },
    });
    workspaceId = workspace.id;
    workspaceIds.push(workspace.id);
    await prisma.workspaceMembership.createMany({
      data: [
        { workspaceId, userId: owner.id, role: 'OWNER', status: 'ACTIVE' },
        { workspaceId, userId: member.id, role: 'MEMBER', status: 'ACTIVE' },
      ],
    });

    const department = await prisma.department.create({
      data: { workspaceId, name: `Engineering ${needle}` },
    });
    await prisma.team.create({
      data: {
        workspaceId,
        departmentId: department.id,
        name: `Alpha ${needle}`,
        description: `Team ${needle}`,
      },
    });

    const publicProject = await prisma.project.create({
      data: {
        workspaceId,
        name: `Public ${needle}`,
        key: `P${Date.now()}`,
        visibility: 'WORKSPACE',
        ownerId: owner.id,
      },
    });
    const privateProject = await prisma.project.create({
      data: {
        workspaceId,
        name: `Secret ${needle}`,
        key: `S${Date.now()}`,
        visibility: 'PRIVATE',
        ownerId: owner.id,
      },
    });
    publicProjectId = publicProject.id;
    privateProjectId = privateProject.id;

    const publicTask = await prisma.task.create({
      data: {
        projectId: publicProject.id,
        key: 'T1',
        title: `Task ${needle}`,
        creatorId: owner.id,
      },
    });
    const privateTask = await prisma.task.create({
      data: {
        projectId: privateProject.id,
        key: 'T2',
        title: `Hidden task ${needle}`,
        creatorId: owner.id,
      },
    });
    publicTaskId = publicTask.id;
    privateTaskId = privateTask.id;

    const publicDocument = await prisma.document.create({
      data: {
        workspaceId,
        title: `Document ${needle}`,
        content: `Body ${needle}`,
        authorId: owner.id,
      },
    });
    const privateDocument = await prisma.document.create({
      data: {
        workspaceId,
        projectId: privateProject.id,
        title: `Private document ${needle}`,
        content: `Secret body ${needle}`,
        authorId: owner.id,
      },
    });
    publicDocumentId = publicDocument.id;
    privateDocumentId = privateDocument.id;

    const publicFile = await prisma.fileAttachment.create({
      data: {
        workspaceId,
        uploadedById: owner.id,
        fileName: `notes-${needle}.txt`,
        mimeType: 'text/plain',
        sizeBytes: 10,
        storageKey: `test/${suffix}/public`,
        extractedText: `Extracted ${needle} content`,
      },
    });
    const privateFile = await prisma.fileAttachment.create({
      data: {
        workspaceId,
        projectId: privateProject.id,
        uploadedById: owner.id,
        fileName: `secret-${needle}.txt`,
        mimeType: 'text/plain',
        sizeBytes: 10,
        storageKey: `test/${suffix}/private`,
        extractedText: `Hidden ${needle} content`,
      },
    });
    publicFileId = publicFile.id;
    privateFileId = privateFile.id;

    const publicChannel = await prisma.channel.create({
      data: { workspaceId, type: 'WORKSPACE', name: `general-${needle}`, createdById: owner.id },
    });
    const privateChannel = await prisma.channel.create({
      data: { workspaceId, type: 'PRIVATE', name: `secret-chat-${needle}`, createdById: owner.id },
    });
    publicChannelId = publicChannel.id;
    privateChannelId = privateChannel.id;
    await prisma.channelMembership.create({
      data: { channelId: privateChannel.id, userId: owner.id },
    });

    const publicMessage = await prisma.message.create({
      data: { channelId: publicChannel.id, authorId: owner.id, body: `Message ${needle} body` },
    });
    const privateMessage = await prisma.message.create({
      data: { channelId: privateChannel.id, authorId: owner.id, body: `Secret message ${needle}` },
    });
    publicMessageId = publicMessage.id;
    privateMessageId = privateMessage.id;

    await prisma.meeting.create({
      data: {
        workspaceId,
        createdById: owner.id,
        title: `Meeting ${needle}`,
        description: `Meet ${needle}`,
      },
    });
  });

  after(async () => {
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  test('all categories return authorised results', async () => {
    const page = await service.searchPage(ownerId, {
      query: needle,
      category: 'all',
      workspaceId,
      limit: 50,
    });
    const types = new Set(page.results.map((result) => result.type));
    for (const type of [
      'person',
      'workspace',
      'team',
      'department',
      'project',
      'task',
      'message',
      'conversation',
      'file',
      'document',
      'meeting',
      'channel',
    ]) {
      assert.ok(types.has(type), `missing category: ${type}`);
    }
    assert.equal(
      page.results.some((result) => result.type === 'announcement'),
      false,
    );
  });

  test('people search is limited to shared active workspaces', async () => {
    const page = await service.searchPage(ownerId, {
      query: needle,
      category: 'people',
      workspaceId,
    });
    const ids = page.results.map((result) => result.id);
    assert.ok(ids.includes(memberId));
    assert.ok(ids.includes(ownerId));
    assert.ok(!ids.includes(outsiderId), 'outsider leaked into people search');
  });

  test('member cannot see private project resources but can see workspace resources', async () => {
    const page = await service.searchPage(memberId, {
      query: needle,
      category: 'all',
      workspaceId,
      limit: 50,
    });
    const ids = new Set(page.results.map((result) => result.id));
    assert.ok(ids.has(publicProjectId));
    assert.ok(ids.has(publicTaskId));
    assert.ok(ids.has(publicDocumentId));
    assert.ok(ids.has(publicFileId));
    assert.ok(ids.has(publicChannelId));
    assert.ok(ids.has(publicMessageId));
    assert.ok(!ids.has(privateProjectId), 'private project leaked');
    assert.ok(!ids.has(privateTaskId), 'private task leaked');
    assert.ok(!ids.has(privateDocumentId), 'private document leaked');
    assert.ok(!ids.has(privateFileId), 'private file leaked');
    assert.ok(!ids.has(privateChannelId), 'private channel leaked');
    assert.ok(!ids.has(privateMessageId), 'private message leaked');
  });

  test('owner can see private conversations and messages', async () => {
    const conversations = await service.searchPage(ownerId, {
      query: needle,
      category: 'conversations',
      workspaceId,
    });
    assert.ok(conversations.results.some((result) => result.id === privateChannelId));
    const messages = await service.searchPage(ownerId, {
      query: needle,
      category: 'messages',
      workspaceId,
    });
    assert.ok(messages.results.some((result) => result.id === privateMessageId));
  });

  test('file content extracted at upload time is searchable', async () => {
    const page = await service.searchPage(memberId, {
      query: `Extracted ${needle}`,
      category: 'files',
      workspaceId,
    });
    assert.ok(page.results.some((result) => result.id === publicFileId));
  });

  test('relevance ranks an exact title above a description match', async () => {
    const exact = await prisma.document.create({
      data: { workspaceId, title: needle, content: 'exact', authorId: ownerId },
    });
    const page = await service.searchPage(ownerId, {
      query: needle,
      category: 'documents',
      workspaceId,
    });
    assert.equal(
      page.results[0]?.id,
      exact.id,
      `expected exact match first, got ${page.results[0]?.title}`,
    );
    await prisma.document.delete({ where: { id: exact.id } });
  });

  test('pagination returns stable pages and metadata', async () => {
    const first = await service.searchPage(ownerId, {
      query: needle,
      category: 'all',
      workspaceId,
      page: 1,
      limit: 3,
    });
    const second = await service.searchPage(ownerId, {
      query: needle,
      category: 'all',
      workspaceId,
      page: 2,
      limit: 3,
    });
    assert.equal(first.limit, 3);
    assert.equal(first.page, 1);
    assert.equal(first.hasMore, true);
    assert.equal(second.page, 2);
    assert.equal(first.results.length, 3);
    assert.equal(
      second.results.some((result) =>
        first.results.some((firstResult) => firstResult.id === result.id),
      ),
      false,
    );
  });

  test('suggestions return lightweight ranked titles', async () => {
    const suggestions = await service.suggestions(ownerId, needle, workspaceId);
    assert.ok(suggestions.length > 0 && suggestions.length <= 8);
    assert.ok(
      suggestions.every(
        (suggestion) => suggestion.title && suggestion.type && suggestion.workspaceId,
      ),
    );
  });

  test('recent searches are private per user and can be cleared', async () => {
    const ownerOnlyQuery = `owner-only-${needle}`;
    await service.searchPage(ownerId, {
      query: ownerOnlyQuery,
      category: 'documents',
      workspaceId,
    });
    const ownerHistory = await service.recentSearches(ownerId, workspaceId);
    assert.ok(ownerHistory.some((entry) => entry.query === ownerOnlyQuery));
    const memberHistory = await service.recentSearches(memberId, workspaceId);
    assert.equal(
      memberHistory.some((entry) => entry.query === ownerOnlyQuery),
      false,
      'search history leaked across users',
    );
    const deleted = await service.clearRecentSearches(ownerId, workspaceId);
    assert.ok(deleted >= 1);
    assert.equal((await service.recentSearches(ownerId, workspaceId)).length, 0);
  });

  test('a workspace outside the caller scope returns nothing', async () => {
    const other = await prisma.workspace.create({
      data: {
        name: `Other ${needle}`,
        slug: `other-${process.pid}-${Date.now()}`,
        ownerId: outsiderId,
      },
    });
    workspaceIds.push(other.id);
    const page = await service.searchPage(ownerId, {
      query: needle,
      category: 'all',
      workspaceId: other.id,
    });
    assert.equal(page.results.length, 0);
  });
});
