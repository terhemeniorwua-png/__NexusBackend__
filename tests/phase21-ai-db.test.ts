import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';
import { createApp } from '../src/app';
import { disconnectDatabase, getPrismaClient } from '../src/db/prisma';
import { connectRedis, disconnectRedis } from '../src/db/redis';
import { createAiActionService } from '../src/modules/ai/ai-action.service';
import { createAiService } from '../src/modules/ai/ai.service';
import { createAiUsageService } from '../src/modules/ai/ai-usage.service';
import { createWritingService } from '../src/modules/ai/writing.service';
import type { AiClient } from '../src/services/providers/ai';
import { AppError } from '../src/utils/errors';
import {
  connectTestDatabase,
  resolveTestDatabaseUrl,
  type TestDatabase,
} from './helpers/test-database';
import { loadTestConfig } from './helpers/test-config';
import { CookieJar, jsonRequest, startServer, type RunningServer } from './helpers/test-server';

const DB_FLAG = 'RUN_PHASE21_DB_TESTS';
const databaseUrl = resolveTestDatabaseUrl(DB_FLAG);

if (!databaseUrl) {
  describe('Phase 21 AI service database tests', () =>
    test('skipped — set RUN_PHASE21_DB_TESTS=true to run', () => {}));
} else {
  runTests(databaseUrl);
}

interface TestUser {
  id: string;
  email: string;
  token: string;
  jar: CookieJar;
}

function createStubClient(): AiClient {
  const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

  return {
    isConfigured: () => true,
    async chat(request) {
      const first = request.context?.[0];
      return {
        content: `Answer based on ${request.context?.length ?? 0} sources`,
        model: 'stub-model',
        usage,
        references: first ? [{ ...first }] : [],
      };
    },
    async *streamChat(request) {
      yield { type: 'token', content: 'Hello ' };
      yield { type: 'token', content: 'there' };
      const first = request.context?.[0];
      yield {
        type: 'done',
        response: {
          content: 'Hello there',
          model: 'stub-model',
          usage,
          references: first ? [{ ...first }] : [],
        },
      };
    },
    async analyzeWriting() {
      return {
        suggestions: [
          {
            id: 's1',
            category: 'SPELLING' as const,
            severity: 'medium' as const,
            message: 'Typo',
            original: 'teh',
            replacement: 'the',
            offset: 0,
            length: 3,
          },
          {
            id: 's2',
            category: 'STYLE' as const,
            severity: 'low' as const,
            message: 'Word choice',
            original: 'cat',
            replacement: 'dog',
            offset: 4,
            length: 3,
          },
        ],
        detectedTone: 'neutral',
        summary: 'A short summary',
        model: 'stub-model',
        usage,
      };
    },
    async rewrite(request) {
      return {
        text: `${request.text} [improved]`,
        explanation: 'Clearer',
        model: 'stub-model',
        usage,
      };
    },
    async health() {
      return { status: 'up', latencyMs: 1, version: 'stub' };
    },
  };
}

function runTests(rawDbUrl: string): void {
  let server: RunningServer;
  let baseUrl: string;
  let database: TestDatabase;
  let owner: TestUser;
  let member: TestUser;
  let limitUser: TestUser;
  let workspaceId: string;
  let projectId: string;
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  const tag = `${process.pid}-${Date.now()}`;

  const auth = (user: TestUser) => ({
    Authorization: `Bearer ${user.token}`,
    'x-csrf-token': user.jar.get('nexus_csrf') ?? '',
  });

  async function register(name: string, suffix: string): Promise<TestUser> {
    const email = `p21-${suffix}-${tag}@test.example`;
    const password = 'TestPass123!';
    const jar = new CookieJar();
    const response = await jsonRequest(`${baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
      jar,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));

    const user = await database.prisma.user.findUniqueOrThrow({ where: { email } });
    await database.prisma.user.update({
      where: { id: user.id },
      data: { status: 'ACTIVE', emailVerifiedAt: new Date() },
    });
    await database.prisma.authToken.updateMany({
      where: { userId: user.id, purpose: 'EMAIL_VERIFICATION', usedAt: null },
      data: { usedAt: new Date() },
    });

    const login = await jsonRequest<{ accessToken: string }>(`${baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password }),
      jar,
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const token = (login.body.data as { accessToken: string }).accessToken;
    const me = await jsonRequest(`${baseUrl}/api/v1/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      jar,
    });
    const id = (me.body.data as { user: { id: string } }).user.id;
    userIds.push(id);
    return { id, email, token, jar };
  }

  const rateLimitOverrides = {
    RATE_LIMIT_NAMESPACE: `p21-${tag}`,
    RATE_LIMIT_MAX: '100000',
    AUTH_REGISTER_RATE_LIMIT_MAX: '1000',
  };

  before(async () => {
    database = await connectTestDatabase(rawDbUrl);
    // The application uses the shared client; the test uses the dedicated
    // database client above so assertions never share request state.
    getPrismaClient(database.url);

    const config = loadTestConfig({ ...rateLimitOverrides, AI_ENABLED: 'false' });
    await connectRedis(config);
    server = await startServer(createApp({ config }));
    baseUrl = server.baseUrl;

    owner = await register('Phase21 Owner', 'owner');
    member = await register('Phase21 Member', 'member');
    limitUser = await register('Phase21 Limit', 'limit');

    const created = await jsonRequest(`${baseUrl}/api/v1/workspaces`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ name: `Phase21 AI ${tag}` }),
      jar: owner.jar,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    workspaceId = (created.body.data as { id: string }).id;
    workspaceIds.push(workspaceId);

    const added = await jsonRequest(`${baseUrl}/api/v1/workspaces/${workspaceId}/members`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ email: member.email, role: 'MEMBER' }),
      jar: owner.jar,
    });
    assert.equal(added.status, 201, JSON.stringify(added.body));

    // A private project is invisible to a plain workspace member unless they
    // are explicitly added to it. It exercises the context permission filter.
    const project = await database.prisma.project.create({
      data: {
        workspaceId,
        name: 'Private AI Project',
        key: `P21${Date.now() % 100_000}`,
        ownerId: owner.id,
        visibility: 'PRIVATE',
        description: 'Only the owner can see this project.',
      },
    });
    projectId = project.id;
  });

  after(async () => {
    await server?.close();
    await disconnectRedis();
    if (database) {
      await database.prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await database.prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await database.prisma.$disconnect();
    }
    await disconnectDatabase();
  });

  function aiConfig(overrides: NodeJS.ProcessEnv = {}) {
    return loadTestConfig({
      ...rateLimitOverrides,
      AI_ENABLED: 'true',
      AI_SERVICE_URL: 'https://ai.test',
      AI_SERVICE_TOKEN: 'x'.repeat(40),
      AI_MODEL: 'stub-model',
      ...overrides,
    });
  }

  test('AI routes degrade cleanly when the service is not configured', async () => {
    const health = await jsonRequest(`${baseUrl}/api/v1/ai/health`, {
      headers: auth(owner),
      jar: owner.jar,
    });
    assert.equal(health.status, 200, JSON.stringify(health.body));
    const healthData = health.body.data as { configured: boolean; status: string };
    assert.equal(healthData.configured, false);
    assert.equal(healthData.status, 'down');

    const chat = await jsonRequest(`${baseUrl}/api/v1/ai/chat`, {
      method: 'POST',
      headers: auth(owner),
      body: JSON.stringify({ workspaceId, query: 'Hello' }),
      jar: owner.jar,
    });
    assert.equal(chat.status, 503, JSON.stringify(chat.body));
    assert.equal(chat.body.error?.code, 'AI_NOT_CONFIGURED');
  });

  test('chat prepares permission-filtered context and persists the conversation', async () => {
    const config = aiConfig();
    const service = createAiService(config, {
      prisma: database.prisma,
      client: createStubClient(),
    });

    const result = await service.chat({
      userId: owner.id,
      workspaceId,
      query: 'Summarise the private project',
    });

    assert.ok(result.conversationId);
    assert.match(result.answer, /sources/);
    assert.ok(
      result.sources.some((source) => source.type === 'project' && source.id === projectId),
      'the owner should receive the private project as context',
    );

    const conversation = await database.prisma.aiConversation.findUniqueOrThrow({
      where: { id: result.conversationId },
      include: { messages: true },
    });
    assert.equal(conversation.userId, owner.id);
    assert.equal(conversation.workspaceId, workspaceId);
    assert.equal(conversation.messages.length, 2);
    assert.deepEqual(conversation.messages.map((message) => message.role).sort(), [
      'ASSISTANT',
      'USER',
    ]);

    const usage = await database.prisma.aiUsageRecord.findFirst({
      where: { userId: owner.id, conversationId: result.conversationId },
    });
    assert.equal(usage?.status, 'SUCCESS');
    assert.equal(usage?.totalTokens, 15);

    const memberResult = await service.chat({
      userId: member.id,
      workspaceId,
      query: 'What is happening?',
    });
    assert.ok(
      !memberResult.sources.some((source) => source.id === projectId),
      'a plain member must not receive the private project as context',
    );

    await assert.rejects(
      () =>
        service.chat({
          userId: limitUser.id,
          workspaceId,
          query: 'Let me in',
        }),
      (error: unknown) => error instanceof AppError && error.statusCode === 403,
    );
  });

  test('conversation ownership is enforced for reads and deletes', async () => {
    const service = createAiService(aiConfig(), {
      prisma: database.prisma,
      client: createStubClient(),
    });
    const created = await service.chat({
      userId: owner.id,
      workspaceId,
      query: 'Owner only conversation',
    });

    await assert.rejects(
      () => service.getConversation(member.id, created.conversationId),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );
    await assert.rejects(
      () => service.deleteConversation(member.id, created.conversationId),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );

    const listed = await service.listConversations(owner.id, { workspaceId });
    assert.ok(listed.items.some((item) => item.id === created.conversationId));

    const deleted = await service.deleteConversation(owner.id, created.conversationId);
    assert.equal(deleted.deleted, true);
  });

  test('writing analysis is non-destructive and accepts suggestions explicitly', async () => {
    const service = createWritingService(aiConfig(), {
      prisma: database.prisma,
      client: createStubClient(),
    });

    const analysis = await service.analyze({
      userId: owner.id,
      workspaceId,
      text: 'teh cat',
      features: ['SPELLING', 'STYLE'],
    });
    assert.equal(analysis.suggestions.length, 2);
    assert.equal(analysis.detectedTone, 'neutral');

    const session = await database.prisma.aiWritingSession.findUniqueOrThrow({
      where: { id: analysis.sessionId },
    });
    assert.equal(session.status, 'ACTIVE');
    assert.equal(session.originalText, 'teh cat');

    const accepted = await service.acceptSuggestion(owner.id, analysis.sessionId, ['s1']);
    assert.equal(accepted.text, 'the cat');
    assert.deepEqual(accepted.appliedSuggestionIds, ['s1']);

    const afterAccept = await database.prisma.aiWritingSession.findUniqueOrThrow({
      where: { id: analysis.sessionId },
    });
    assert.equal(afterAccept.status, 'ACCEPTED');
    assert.equal(afterAccept.originalText, '');

    await assert.rejects(
      () => service.acceptSuggestion(owner.id, analysis.sessionId, ['s1']),
      (error: unknown) => error instanceof AppError && error.statusCode === 409,
    );

    const second = await service.analyze({
      userId: owner.id,
      workspaceId,
      text: 'teh cat',
      features: ['SPELLING'],
    });
    const dismissed = await service.dismissSession(owner.id, second.sessionId);
    assert.equal(dismissed.dismissed, true);
    const afterDismiss = await database.prisma.aiWritingSession.findUniqueOrThrow({
      where: { id: second.sessionId },
    });
    assert.equal(afterDismiss.status, 'DISMISSED');
  });

  test('AI actions require approval and execute exactly once', async () => {
    const service = createAiActionService(aiConfig(), { prisma: database.prisma });
    const idempotencyKey = `p21-action-${tag}`;

    const proposal = await service.propose(
      owner.id,
      {
        workspaceId,
        actionType: 'CREATE_TASK',
        title: 'Create an AI task',
        idempotencyKey,
        payload: {
          projectId,
          title: 'Task proposed by AI',
          description: 'Created after explicit approval.',
        },
      },
      { ip: '127.0.0.1', userAgent: 'phase21-test' },
    );
    assert.equal(proposal.status, 'PROPOSED');

    const duplicate = await service.propose(owner.id, {
      workspaceId,
      actionType: 'CREATE_TASK',
      title: 'Create an AI task',
      idempotencyKey,
      payload: { projectId, title: 'Task proposed by AI' },
    });
    assert.equal(duplicate.id, proposal.id);

    await assert.rejects(
      () => service.execute(owner.id, proposal.id, { ip: '127.0.0.1' }),
      (error: unknown) => error instanceof AppError && error.code === 'AI_ACTION_NOT_APPROVED',
    );

    const approved = await service.approve(owner.id, proposal.id, 'Looks correct', {
      ip: '127.0.0.1',
      userAgent: 'phase21-test',
    });
    assert.equal(approved.status, 'APPROVED');

    const executed = await service.execute(owner.id, proposal.id, { ip: '127.0.0.1' });
    assert.equal(executed.status, 'EXECUTED');
    const result = executed.executionResult as { taskId: string; key: string };
    assert.ok(result.taskId);

    const task = await database.prisma.task.findUniqueOrThrow({
      where: { id: result.taskId },
    });
    assert.equal(task.title, 'Task proposed by AI');
    assert.equal(task.projectId, projectId);

    await assert.rejects(
      () => service.execute(owner.id, proposal.id, { ip: '127.0.0.1' }),
      (error: unknown) => error instanceof AppError && error.code === 'AI_ACTION_NOT_APPROVED',
    );

    await assert.rejects(
      () =>
        service.propose(member.id, {
          workspaceId,
          actionType: 'CREATE_TASK',
          payload: { projectId, title: 'Member cannot do this' },
        }),
      (error: unknown) => error instanceof AppError && error.statusCode >= 403,
    );
  });

  test('AI actions can be rejected and are then inert', async () => {
    const service = createAiActionService(aiConfig(), { prisma: database.prisma });
    const proposal = await service.propose(owner.id, {
      workspaceId,
      actionType: 'CREATE_TASK',
      idempotencyKey: `p21-reject-${tag}`,
      payload: { projectId, title: 'Rejected task' },
    });

    const rejected = await service.reject(owner.id, proposal.id, 'Not now');
    assert.equal(rejected.status, 'REJECTED');

    await assert.rejects(
      () => service.approve(owner.id, proposal.id, undefined),
      (error: unknown) => error instanceof AppError && error.code === 'AI_ACTION_NOT_PENDING',
    );
    await assert.rejects(
      () => service.execute(owner.id, proposal.id),
      (error: unknown) => error instanceof AppError && error.code === 'AI_ACTION_NOT_APPROVED',
    );
  });

  test('AI usage limits are enforced from persisted usage', async () => {
    const usage = createAiUsageService(aiConfig({ AI_DAILY_REQUEST_LIMIT: '1' }), database.prisma);
    await usage.assertWithinLimits(limitUser.id);

    await usage.record({
      userId: limitUser.id,
      operation: 'chat',
      status: 'SUCCESS',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    });

    await assert.rejects(
      () => usage.assertWithinLimits(limitUser.id),
      (error: unknown) => error instanceof AppError && error.code === 'AI_USAGE_LIMIT_EXCEEDED',
    );
  });

  const taskUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

  function taskPreviewClient(previewContent: string): AiClient {
    return {
      isConfigured: () => true,
      async chat() {
        return {
          content: previewContent,
          model: 'stub-model',
          usage: taskUsage,
          references: [],
        };
      },
      async *streamChat() {
        yield {
          type: 'done',
          response: { content: '', model: 'stub', usage: taskUsage, references: [] },
        };
      },
      async analyzeWriting() {
        return {
          suggestions: [],
          detectedTone: null,
          summary: null,
          model: 'stub',
          usage: taskUsage,
        };
      },
      async rewrite() {
        return { text: '', explanation: null, model: 'stub', usage: taskUsage };
      },
      async health() {
        return { status: 'up', latencyMs: 1, version: 'stub' };
      },
    };
  }

  test('task generator returns a validated preview and saves nothing', async () => {
    const service = createAiService(aiConfig(), {
      prisma: database.prisma,
      client: taskPreviewClient(
        JSON.stringify({
          title: 'Review the draft',
          description: 'Proofread and publish the project draft.',
          status: 'ASSIGNED',
          priority: 'HIGH',
          labels: ['review'],
        }),
      ),
    });

    const preview = await service.generateTaskPreview({
      userId: owner.id,
      workspaceId,
      projectId,
      prompt: 'Create a review task for the draft.',
    });

    assert.equal(preview.title, 'Review the draft');
    assert.equal(preview.priority, 'HIGH');
    assert.deepEqual(preview.labels, ['review']);

    // Nothing is persisted: no new conversation or task is created by generation.
    const conversationsBefore = await database.prisma.aiConversation.count();
    const tasksBefore = await database.prisma.task.count({ where: { projectId } });
    const conversationsAfter = await database.prisma.aiConversation.count();
    const tasksAfter = await database.prisma.task.count({ where: { projectId } });
    assert.equal(conversationsAfter, conversationsBefore);
    assert.equal(tasksAfter, tasksBefore);
  });

  test('task generator rejects invalid model output', async () => {
    const service = createAiService(aiConfig(), {
      prisma: database.prisma,
      client: taskPreviewClient('not valid json'),
    });

    await assert.rejects(
      () =>
        service.generateTaskPreview({
          userId: owner.id,
          workspaceId,
          projectId,
          prompt: 'Make a task',
        }),
      (error: unknown) =>
        error instanceof AppError && error.code === 'AI_TASK_PREVIEW_INVALID',
    );
  });

  test('task generation is rejected for a project the caller cannot access', async () => {
    const service = createAiService(aiConfig(), {
      prisma: database.prisma,
      client: taskPreviewClient(
        JSON.stringify({ title: 'Should not happen', priority: 'LOW' }),
      ),
    });

    await assert.rejects(
      () =>
        service.generateTaskPreview({
          userId: member.id,
          workspaceId,
          projectId,
          prompt: 'Make a task',
        }),
      (error: unknown) =>
        error instanceof AppError && error.statusCode === 404,
    );
  });

  test('confirming a task preview creates a task through the task service', async () => {
    const service = createAiService(aiConfig(), { prisma: database.prisma });

    const created = await service.confirmTaskGeneration(
      {
        userId: owner.id,
        workspaceId,
        projectId,
        preview: { title: 'Confirmed task', priority: 'MEDIUM' },
      },
      { ip: '127.0.0.1', userAgent: 'phase21-test' },
    );

    assert.ok(created.taskId);
    const task = await database.prisma.task.findUnique({ where: { id: created.taskId } });
    assert.ok(task);
    assert.equal(task.title, 'Confirmed task');
    assert.equal(task.priority, 'MEDIUM');
    assert.equal(task.projectId, projectId);
    assert.equal(task.creatorId, owner.id);
  });

  test('confirming a task preview is rejected for an inaccessible project', async () => {
    const service = createAiService(aiConfig(), { prisma: database.prisma });

    await assert.rejects(
      () =>
        service.confirmTaskGeneration(
          {
            userId: member.id,
            workspaceId,
            projectId,
            preview: { title: 'Should not exist' },
          },
          { ip: '127.0.0.1' },
        ),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );
  });
}
