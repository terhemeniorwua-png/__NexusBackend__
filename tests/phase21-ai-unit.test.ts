import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { CircuitBreaker } from '../src/services/providers/ai/circuit-breaker';
import {
  AiProviderError,
  AiUnavailableError,
  createAiClient,
  type AiClientConfig,
} from '../src/services/providers/ai';
import { applySuggestions } from '../src/modules/ai/writing.service';

const baseConfig: AiClientConfig = {
  aiEnabled: true,
  aiServiceUrl: 'https://ai.test',
  aiServiceToken: 'x'.repeat(40),
  aiModel: 'test-model',
  aiRequestTimeoutMs: 1_000,
  aiStreamTimeoutMs: 1_000,
  aiCircuitBreakerFailures: 2,
  aiCircuitBreakerResetMs: 50,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('AI circuit breaker', () => {
  test('opens after the failure threshold and half-opens after the reset window', () => {
    let now = 1_000;
    const breaker = new CircuitBreaker(2, 100, () => now);

    assert.equal(breaker.allowRequest(), true);
    breaker.onFailure();
    assert.equal(breaker.currentState, 'closed');
    breaker.onFailure();
    assert.equal(breaker.currentState, 'open');
    assert.equal(breaker.allowRequest(), false);

    now += 101;
    assert.equal(breaker.currentState, 'half_open');
    assert.equal(breaker.allowRequest(), true);

    breaker.onFailure();
    assert.equal(breaker.currentState, 'open');
  });
});

describe('AI writing suggestion application', () => {
  test('applies non-overlapping suggestions from the end of the text', () => {
    const text = 'teh cat sat';
    const result = applySuggestions(text, [
      {
        id: 'a',
        category: 'SPELLING',
        severity: 'medium',
        message: 'Typo',
        original: 'teh',
        replacement: 'the',
        offset: 0,
        length: 3,
      },
      {
        id: 'b',
        category: 'STYLE',
        severity: 'low',
        message: 'Word choice',
        original: 'sat',
        replacement: 'rested',
        offset: 8,
        length: 3,
      },
    ]);
    assert.equal(result, 'the cat rested');
  });

  test('ignores overlapping and out-of-range suggestions', () => {
    const text = 'hello world';
    const result = applySuggestions(text, [
      {
        id: 'a',
        category: 'STYLE',
        severity: 'low',
        message: 'Overlap',
        original: 'hello',
        replacement: 'hi',
        offset: 0,
        length: 5,
      },
      {
        id: 'b',
        category: 'STYLE',
        severity: 'low',
        message: 'Nested',
        original: 'ell',
        replacement: 'xyz',
        offset: 1,
        length: 3,
      },
      {
        id: 'c',
        category: 'STYLE',
        severity: 'low',
        message: 'Out of range',
        original: 'missing',
        replacement: 'nope',
        offset: 500,
        length: 5,
      },
    ]);
    assert.equal(result, 'hi world');
  });
});

describe('AI service client', () => {
  test('throws AiUnavailableError when not configured', async () => {
    const client = createAiClient({ ...baseConfig, aiEnabled: false });
    assert.equal(client.isConfigured(), false);
    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'hi' }], operation: 'chat' }),
      (error: unknown) => error instanceof AiUnavailableError && error.code === 'AI_NOT_CONFIGURED',
    );
  });

  test('sends the service bearer token and normalizes the response', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const client = createAiClient(baseConfig, {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return jsonResponse({
          content: 'An answer [workspace:ws-1]',
          model: 'test-model',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          references: [{ type: 'workspace', id: 'ws-1', title: 'Demo' }, { type: 'workspace' }],
        });
      }) as typeof fetch,
    });

    const response = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      operation: 'chat',
    });

    assert.equal(response.content, 'An answer [workspace:ws-1]');
    assert.equal(response.usage.totalTokens, 15);
    assert.equal(response.references.length, 1);
    const headers = captured!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${baseConfig.aiServiceToken}`);
    assert.equal(captured!.url, 'https://ai.test/v1/chat');
  });

  test('maps an HTTP failure to AiProviderError', async () => {
    const client = createAiClient(baseConfig, {
      fetchImpl: (async () =>
        jsonResponse({ error: { code: 'UPSTREAM', message: 'Nope' } }, 500)) as typeof fetch,
    });

    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'hi' }], operation: 'chat' }),
      (error: unknown) =>
        error instanceof AiProviderError && error.code === 'UPSTREAM' && error.statusCode === 500,
    );
  });

  test('parses a streamed response and yields a final result', async () => {
    const client = createAiClient(baseConfig, {
      fetchImpl: (async () =>
        sseResponse([
          'data: {"type":"token","content":"Hello "}\n\n',
          'data: {"type":"token","content":"world"}\n\n',
          'data: {"type":"done","response":{"content":"Hello world","model":"test-model","usage":{"totalTokens":3},"references":[]}}\n\n',
        ])) as typeof fetch,
    });

    const events: string[] = [];
    let finalContent = '';
    for await (const event of client.streamChat({
      messages: [{ role: 'user', content: 'hi' }],
      operation: 'chat_stream',
    })) {
      events.push(event.type);
      if (event.type === 'done') finalContent = event.response.content;
    }

    assert.deepEqual(events, ['token', 'token', 'done']);
    assert.equal(finalContent, 'Hello world');
  });

  test('reports health for a configured service', async () => {
    const client = createAiClient(baseConfig, {
      fetchImpl: (async () => jsonResponse({ version: '1.2.3' })) as typeof fetch,
    });
    const health = await client.health();
    assert.equal(health.status, 'up');
    assert.equal(health.version, '1.2.3');
  });
});
