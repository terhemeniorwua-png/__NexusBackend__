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
  aiFastModel: '',
  aiProvider: 'openrouter',
  openrouterApiKey: 'test-key',
  emailAppUrl: 'http://localhost:3000',
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

  test('sends the OpenRouter bearer token and normalizes the response', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const client = createAiClient(baseConfig, {
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(url), init: init ?? {} };
        return jsonResponse({
          id: 'chatcmpl-1',
          model: 'test-model',
          choices: [{ message: { role: 'assistant', content: 'An answer [workspace:ws-1]' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }) as typeof fetch,
    });

    const response = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      operation: 'chat',
    });

    assert.equal(response.content, 'An answer [workspace:ws-1]');
    assert.equal(response.usage.totalTokens, 15);
    assert.equal(response.references.length, 0);
    const headers = captured!.init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Bearer ${baseConfig.openrouterApiKey}`);
    assert.equal(captured!.url, 'https://openrouter.ai/api/v1/chat/completions');
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

  test('parses an OpenRouter streamed response and yields a final result', async () => {
    const client = createAiClient(baseConfig, {
      fetchImpl: (async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
          'data: [DONE]\n\n',
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

  test('reports health for a configured provider', async () => {
    const client = createAiClient(baseConfig, {
      fetchImpl: (async () => jsonResponse({})) as typeof fetch,
    });
    const health = await client.health();
    assert.equal(health.status, 'up');
    assert.equal(health.version, 'openrouter');
  });
});

describe('OpenRouter client', () => {
  function errorResponse(code: unknown, message: unknown, status: number): Response {
    return jsonResponse({ error: { code, message } }, status);
  }

  function emptyChatResponse(): Response {
    return jsonResponse({
      id: 'chatcmpl-empty',
      model: 'test-model',
      choices: [{ message: { role: 'assistant', content: '' } }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  function successChatResponse(content: string): Response {
    return jsonResponse({
      id: 'chatcmpl-ok',
      model: 'test-model',
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    });
  }

  test('returns 401 as AiProviderError', async () => {
    const client = createAiClient(baseConfig, {
      fetchImpl: (async () => errorResponse('invalid_key', 'Invalid API key', 401)) as typeof fetch,
    });

    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'hi' }], operation: 'chat' }),
      (error: unknown) =>
        error instanceof AiProviderError &&
        error.code === 'invalid_key' &&
        error.statusCode === 401,
    );
  });

  test('returns 402 as AiProviderError', async () => {
    const client = createAiClient(baseConfig, {
      fetchImpl: (async () =>
        errorResponse('insufficient_credits', 'Insufficient credits', 402)) as typeof fetch,
    });

    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'hi' }], operation: 'chat' }),
      (error: unknown) =>
        error instanceof AiProviderError &&
        error.code === 'insufficient_credits' &&
        error.statusCode === 402,
    );
  });

  test('returns 429 as AiProviderError', async () => {
    const client = createAiClient(baseConfig, {
      fetchImpl: (async () =>
        errorResponse('rate_limit', 'Rate limited', 429)) as typeof fetch,
    });

    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'hi' }], operation: 'chat' }),
      (error: unknown) =>
        error instanceof AiProviderError &&
        error.code === 'rate_limit' &&
        error.statusCode === 429,
    );
  });

  test('times out and reports AI_TIMEOUT', async () => {
    const client = createAiClient(
      { ...baseConfig, aiRequestTimeoutMs: 50 },
      {
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal as AbortSignal | undefined;
            const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
            signal?.addEventListener('abort', onAbort, { once: true });
            // never resolves on its own; the client's timeout aborts the signal
          });
        }) as typeof fetch,
      },
    );

    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'hi' }], operation: 'chat' }),
      (error: unknown) =>
        error instanceof AiUnavailableError && error.code === 'AI_TIMEOUT',
    );
  });

  test('retries once on an empty response', async () => {
    let calls = 0;
    const client = createAiClient(baseConfig, {
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) return emptyChatResponse();
        return successChatResponse('Retry succeeded');
      }) as typeof fetch,
    });

    const response = await client.chat({
      messages: [{ role: 'user', content: 'hi' }],
      operation: 'chat',
    });
    assert.equal(response.content, 'Retry succeeded');
    assert.equal(calls, 2);
  });

  test('drops suggestions on invalid JSON and does not crash', async () => {
    const client = createAiClient(baseConfig, {
      fetchImpl: (async () =>
        jsonResponse({
          id: 'chatcmpl-badjson',
          model: 'test-model',
          choices: [{ message: { role: 'assistant', content: 'not json at all' } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        })) as typeof fetch,
    });

    const result = await client.analyzeWriting({
      text: 'hello',
      features: ['SPELLING'],
      operation: 'writing_analyze',
    });
    assert.equal(result.suggestions.length, 0);
    assert.equal(result.model, 'test-model');
  });

  test('opens the circuit breaker after the failure threshold', async () => {
    const failingConfig = {
      ...baseConfig,
      aiCircuitBreakerFailures: 2,
      aiCircuitBreakerResetMs: 60_000,
    };
    const client = createAiClient(failingConfig, {
      fetchImpl: (async () =>
        errorResponse('upstream', 'Down', 500)) as typeof fetch,
    });

    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'a' }], operation: 'chat' }),
      (error: unknown) => error instanceof AiProviderError,
    );
    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'b' }], operation: 'chat' }),
      (error: unknown) => error instanceof AiProviderError,
    );
    await assert.rejects(
      () => client.chat({ messages: [{ role: 'user', content: 'c' }], operation: 'chat' }),
      (error: unknown) =>
        error instanceof AiUnavailableError && error.code === 'AI_CIRCUIT_OPEN',
    );
  });
});
