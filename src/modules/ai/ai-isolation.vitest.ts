/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AiClient } from '../../services/providers/ai';

const wsAuth = vi.hoisted(() => ({
  requireWorkspaceAccess: vi.fn(async () => ({ effectiveRole: 'MEMBER', membership: {}, workspace: { id: 'w1' } })),
  WorkspaceCapability: { ViewWorkspace: 'workspace:view' },
}));
const aiAccessMock = vi.hoisted(() => ({
  assertAiWorkspaceEntitled: vi.fn(async () => undefined),
}));
vi.mock('../authorization', () => ({
  ...wsAuth,
  requireProjectAccess: vi.fn(),
  ProjectCapability: {},
  requireChannelAccess: vi.fn(),
  ChannelCapability: {},
}));
vi.mock('./ai-access', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai-access')>();
  return { ...actual, assertAiWorkspaceEntitled: aiAccessMock.assertAiWorkspaceEntitled };
});

import { createAiService } from './ai.service';

const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

function stubClient(overrides: Partial<AiClient> = {}): AiClient {
  return {
    isConfigured: () => true,
    async chat() {
      return { content: 'ok', model: 'm', usage, references: [] };
    },
    async *streamChat() {
      yield { type: 'done', response: { content: 'ok', model: 'm', usage, references: [] } } as any;
    },
    async analyzeWriting() {
      return { suggestions: [], detectedTone: null, summary: null, model: 'm', usage };
    },
    async rewrite() {
      return { text: 'x', explanation: null, model: 'm', usage };
    },
    async health() {
      return { status: 'up', latencyMs: 1 };
    },
    ...overrides,
  };
}

function makePrisma() {
  return {
    workspace: { findUnique: vi.fn(async () => ({ type: 'INDIVIDUAL', subscription: null })) },
    aiConversation: {
      findFirst: vi.fn(),
      create: vi.fn(async ({ data }: any) => ({ id: 'conv1', userId: data.userId, workspaceId: data.workspaceId ?? null, title: data.title, status: 'ACTIVE', contextType: data.contextType ?? null, contextId: data.contextId ?? null, lastMessageAt: new Date(), createdAt: new Date(), updatedAt: new Date() })),
      update: vi.fn(async () => ({})),
    },
    aiMessage: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({ id: 'm1' })) },
    aiUsageRecord: { create: vi.fn(async () => ({})), count: vi.fn(async () => 0), aggregate: vi.fn(async () => ({ _sum: { totalTokens: 0 } })) },
    $transaction: vi.fn(async (ops: any) => Promise.all(ops)),
  } as any;
}

describe('AI access isolation (no output derived from inaccessible content)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aiAccessMock.assertAiWorkspaceEntitled.mockResolvedValue(undefined);
  });

  it('chat never forwards inaccessible sources and strips unauthorized references from provider output', async () => {
    const prisma = makePrisma();
    const allowedSource = { type: 'project', id: 'p-allowed', title: 'Allowed', workspaceId: 'w1', snippet: 'safe' };
    const secretSource = { type: 'project', id: 'p-secret', title: 'Secret', workspaceId: 'w1', snippet: 'TOP SECRET' };

    const contextService = {
      build: vi.fn(async () => ({ workspaceId: 'w1', sources: [allowedSource], text: '[project:p-allowed] Allowed\nsafe' })),
    };
    const usageService = {
      assertWithinLimits: vi.fn(async () => undefined),
      record: vi.fn(async () => undefined),
    };

    let captured: any = null;
    const client = stubClient({
      async chat(req: any) {
        captured = req;
        return {
          content: 'Leaked [project:p-secret] TOP SECRET',
          model: 'm',
          usage,
          references: [secretSource, allowedSource],
        };
      },
    });

    const service = createAiService({} as any, {
      prisma,
      client,
      contextService: contextService as any,
      usageService: usageService as any,
    });

    const result = await service.chat({ userId: 'u1', workspaceId: 'w1', query: 'tell me secrets' } as any);

    expect(captured.context).toEqual([allowedSource]);
    expect(JSON.stringify(captured)).not.toContain('p-secret');
    expect(JSON.stringify(captured)).not.toContain('TOP SECRET');
    expect(result.references).toEqual([allowedSource]);
    expect(JSON.stringify(result.references)).not.toContain('p-secret');
    expect(result.sources).toEqual([allowedSource]);
  });

  it('streamChat never forwards inaccessible sources and strips unauthorized references', async () => {
    const prisma = makePrisma();
    const allowedSource = { type: 'document', id: 'd-ok', title: 'Doc', workspaceId: 'w1', snippet: 'public-to-user' };
    const secretSource = { type: 'document', id: 'd-secret', title: 'SecretDoc', workspaceId: 'w1', snippet: 'secret' };

    const contextService = {
      build: vi.fn(async () => ({ workspaceId: 'w1', sources: [allowedSource], text: '[document:d-ok] Doc\npublic-to-user' })),
    };
    const usageService = {
      assertWithinLimits: vi.fn(async () => undefined),
      record: vi.fn(async () => undefined),
    };

    let captured: any = null;
    const client = stubClient({
      async *streamChat(req: any) {
        captured = req;
        yield { type: 'references', references: [secretSource, allowedSource] } as any;
        yield { type: 'done', response: { content: 'hi', model: 'm', usage, references: [secretSource] } } as any;
      },
    });

    const service = createAiService({} as any, {
      prisma,
      client,
      contextService: contextService as any,
      usageService: usageService as any,
    });

    const events: any[] = [];
    for await (const e of service.streamChat({ userId: 'u1', workspaceId: 'w1', query: 'q' } as any)) {
      events.push(e);
    }

    expect(captured.context).toEqual([allowedSource]);
    expect(JSON.stringify(captured)).not.toContain('d-secret');
    const refEvent = events.find((e) => e.type === 'references');
    expect(refEvent.references).toEqual([allowedSource]);
    const done = events.find((e) => e.type === 'done');
    expect(done.response.references).toEqual([]);
  });

  it('denies AI access when workspace is not entitled (plan gating)', async () => {
    const { assertAiWorkspaceEntitled } = await vi.importActual<typeof import('./ai-access')>('./ai-access');
    const prisma = {
      workspace: { findUnique: vi.fn(async () => ({ type: 'COMPANY', subscription: { status: 'CANCELLED' } })) },
    };
    await expect(assertAiWorkspaceEntitled(prisma as any, 'w1')).rejects.toMatchObject({ statusCode: 403, code: 'AI_PLAN_REQUIRED' });
  });
});
