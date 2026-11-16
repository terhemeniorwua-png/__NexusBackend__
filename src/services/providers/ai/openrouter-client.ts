import type { AiClientConfig } from './ai-client';
import { logger as defaultLogger, type Logger } from '../../../utils/logger';
import { CircuitBreaker } from './circuit-breaker';
import {
  AiProviderError,
  AiUnavailableError,
  type AiCallOptions,
  type AiChatRequest,
  type AiChatResponse,
  type AiClient,
  type AiHealthStatus,
  type AiRewriteRequest,
  type AiRewriteResponse,
  type AiStreamEvent,
  type AiUsage,
  type AiWritingRequest,
  type AiWritingResponse,
  type AiWritingSuggestion,
} from './types';

/**
 * OpenRouter direct client (Phase 21).
 *
 * Used when `AI_PROVIDER=openrouter`. The backend keeps full ownership of
 * authentication, authorisation and context preparation: OpenRouter only
 * generates the completion. No user credentials are forwarded, and every
 * request is already permission-filtered by Express before it reaches this
 * client.
 *
 * OpenRouter is OpenAI-compatible: `POST /chat/completions` with a bearer
 * token. Errors are translated into clear, typed errors so the AI service
 * layer can map them to HTTP status codes (401, 402, 429, 502, 503).
 */

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_TEMPERATURE = 0.7;
const MAX_EMPTY_RETRIES = 1;

type OpenRouterUsage = {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  total_tokens?: unknown;
};

type OpenRouterChoice = {
  message?: { role?: unknown; content?: unknown } | null;
  delta?: { content?: unknown } | null;
  finish_reason?: unknown;
};

type OpenRouterChatBody = {
  id?: unknown;
  model?: unknown;
  choices?: OpenRouterChoice[] | null;
  usage?: OpenRouterUsage;
};

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function normalizeUsage(value: unknown): AiUsage {
  const usage = (value ?? {}) as Record<string, unknown>;
  const promptTokens = toNumber(usage.promptTokens ?? usage.prompt_tokens);
  const completionTokens = toNumber(usage.completionTokens ?? usage.completion_tokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens: toNumber(usage.totalTokens ?? usage.total_tokens, promptTokens + completionTokens),
  };
}

function normalizeChatResponse(body: unknown, model: string): AiChatResponse {
  const value = (body ?? {}) as Record<string, unknown>;
  const choices = Array.isArray(value.choices) ? value.choices : [];
  const first = choices[0];
  let content = '';
  if (first && typeof first === 'object' && first.message && typeof first.message === 'object') {
    const message = first.message as Record<string, unknown>;
    content = typeof message.content === 'string' ? message.content : '';
  }

  if (!content.trim()) {
    throw new AiProviderError('The AI provider returned an empty response', 'AI_EMPTY_RESPONSE');
  }

  return {
    content,
    model: typeof value.model === 'string' && value.model ? String(value.model) : model,
    usage: normalizeUsage(value.usage),
    references: [],
    ...(typeof first?.finish_reason === 'string' ? { finishReason: first.finish_reason } : {}),
  };
}

function normalizeWritingSuggestion(value: unknown, index: number): AiWritingSuggestion | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const original = typeof item.original === 'string' ? item.original : '';
  const replacement = typeof item.replacement === 'string' ? item.replacement : '';
  if (!original && !replacement) return null;

  const categories = [
    'SPELLING',
    'GRAMMAR',
    'PUNCTUATION',
    'CLARITY',
    'VOCABULARY',
    'TONE',
    'STYLE',
  ] as const;
  const rawCategory = typeof item.category === 'string' ? item.category.toUpperCase() : '';
  const category = (categories as readonly string[]).includes(rawCategory)
    ? (rawCategory as (typeof categories)[number])
    : 'STYLE';
  const severity = item.severity === 'high' || item.severity === 'medium' ? item.severity : 'low';

  return {
    id: typeof item.id === 'string' && item.id ? item.id : `suggestion-${index + 1}`,
    category,
    severity,
    message: typeof item.message === 'string' ? item.message : 'Suggested improvement',
    original,
    replacement,
    offset: toNumber(item.offset),
    length: toNumber(item.length, original.length),
    ...(typeof item.explanation === 'string' ? { explanation: item.explanation } : {}),
  };
}

function errorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const value = body as { error?: { message?: unknown }; message?: unknown; code?: unknown };
  const nested = value.error;
  const message =
    (nested && typeof nested.message === 'string' && nested.message) ||
    (typeof value.message === 'string' && value.message) ||
    fallback;
  return message.slice(0, 300);
}

function errorCode(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const value = body as { error?: { code?: unknown }; code?: unknown };
  const nested = value.error;
  if (nested && typeof nested.code === 'string' && nested.code) return nested.code;
  return typeof value.code === 'string' && value.code ? value.code : fallback;
}

export function createOpenRouterClient(
  config: AiClientConfig,
  options: AiCallOptions & { logger?: Logger; fetchImpl?: typeof fetch } = {},
): AiClient {
  const logger = options.logger ?? defaultLogger;
  const fetchImpl = options.fetchImpl ?? fetch;
  const breaker = new CircuitBreaker(config.aiCircuitBreakerFailures, config.aiCircuitBreakerResetMs);

  const configured = Boolean(
    config.aiEnabled && config.openrouterApiKey.trim().length > 0 && config.aiModel.trim().length > 0,
  );
  const model = config.aiModel.trim();

  function ensureConfigured(): void {
    if (!configured) {
      throw new AiUnavailableError(
        'The AI provider is not configured. Set AI_ENABLED, AI_PROVIDER=openrouter, OPENROUTER_API_KEY and AI_MODEL.',
        'AI_NOT_CONFIGURED',
      );
    }
    if (!breaker.allowRequest()) {
      throw new AiUnavailableError(
        'The AI provider is temporarily unavailable. Please try again shortly.',
        'AI_CIRCUIT_OPEN',
      );
    }
  }

  function defaultHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${config.openrouterApiKey}`,
      'x-title': 'Nexus Backend',
    };
  }

  async function requestJson(
    path: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    ensureConfigured();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    let timedOut = false;
    try {
      const response = await fetchImpl(`${OPENROUTER_BASE_URL}${path}`, {
        method: 'POST',
        headers: defaultHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        const code = errorCode(parsed, `AI_HTTP_${response.status}`);
        const message = errorMessage(parsed, `The AI provider returned HTTP ${response.status}`);
        breaker.onFailure();
        logger.warn('openrouter_request_failed', {
          path,
          statusCode: response.status,
          code,
        });
        throw new AiProviderError(message, code, response.status);
      }

      breaker.onSuccess();
      return parsed;
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      breaker.onFailure();
      timedOut = controller.signal.aborted && !signal?.aborted;
      logger.warn('openrouter_unreachable', { path, timedOut });
      throw new AiUnavailableError(
        timedOut ? 'The AI provider did not respond in time' : 'The AI provider could not be reached',
        timedOut ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE',
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async function chatOnce(
    request: AiChatRequest,
  ): Promise<AiChatResponse> {
    const response = (await requestJson(
      '/chat/completions',
      {
        model: request.model ?? model,
        messages: request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        temperature: request.temperature ?? DEFAULT_TEMPERATURE,
        ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      },
      config.aiRequestTimeoutMs,
    )) as OpenRouterChatBody;

    return normalizeChatResponse(response, model);
  }

  async function chat(request: AiChatRequest): Promise<AiChatResponse> {
    let response: AiChatResponse;
    try {
      response = await chatOnce(request);
    } catch (error) {
      if (
        error instanceof AiProviderError &&
        error.code === 'AI_EMPTY_RESPONSE' &&
        MAX_EMPTY_RETRIES > 0
      ) {
        response = await chatOnce(request);
      } else {
        throw error;
      }
    }
    return response;
  }

  async function* streamChat(
    request: AiChatRequest,
    callOptions: AiCallOptions = {},
  ): AsyncGenerator<AiStreamEvent> {
    ensureConfigured();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.aiStreamTimeoutMs);
    const onExternalAbort = () => controller.abort();
    callOptions.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let timedOut = false;
    try {
      const response = await fetchImpl(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          ...defaultHeaders(),
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: request.model ?? model,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          temperature: request.temperature ?? DEFAULT_TEMPERATURE,
          ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let parsed: unknown = null;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = null;
        }
        breaker.onFailure();
        throw new AiProviderError(
          errorMessage(parsed, `The AI provider returned HTTP ${response.status}`),
          errorCode(parsed, `AI_HTTP_${response.status}`),
          response.status,
        );
      }

      breaker.onSuccess();

      if (!response.body) {
        throw new AiProviderError('The AI provider returned an empty stream', 'AI_EMPTY_RESPONSE');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary: number;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (!data || data === '[DONE]') continue;

              let event: Record<string, unknown>;
              try {
                event = JSON.parse(data) as Record<string, unknown>;
              } catch {
                continue;
              }

              const choices = Array.isArray(event.choices) ? event.choices : [];
              const first = choices[0];
              if (!first || typeof first !== 'object') continue;

              const delta = (first as Record<string, unknown>).delta;
              if (delta && typeof delta === 'object' && typeof (delta as Record<string, unknown>).content === 'string') {
                const token = (delta as Record<string, unknown>).content as string;
                content += token;
                yield { type: 'token', content: token };
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      yield {
        type: 'done',
        response: {
          content,
          model,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          references: [],
          finishReason: 'stop',
        },
      };
    } catch (error) {
      if (error instanceof AiProviderError || error instanceof AiUnavailableError) throw error;
      breaker.onFailure();
      timedOut = controller.signal.aborted && !callOptions.signal?.aborted;
      throw new AiUnavailableError(
        timedOut ? 'The AI stream did not complete in time' : 'The AI stream could not be completed',
        timedOut ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE',
      );
    } finally {
      clearTimeout(timer);
      callOptions.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async function analyzeWriting(request: AiWritingRequest): Promise<AiWritingResponse> {
    const features = (request.features ?? [])
      .filter((feature): feature is string => typeof feature === 'string' && feature.length > 0)
      .slice(0, 7);

    const featureList = features.length > 0 ? features.join(', ') : 'general quality';

    const response = await chatOnce({
      ...request,
      operation: request.operation ?? 'writing_analyze',
      messages: [
        {
          role: 'system',
          content:
            'You are a writing assistant. Analyse the user text for the requested features and return ONLY a JSON object. ' +
            'Do not include markdown fences, commentary, or any text outside the JSON object. ' +
            'The JSON object must have this shape: ' +
            '{"suggestions":[{"id":"<stable-id>","category":"SPELLING|GRAMMAR|PUNCTUATION|CLARITY|VOCABULARY|TONE|STYLE","severity":"low|medium|high","message":"<short description>","original":"<exact text to replace>","replacement":"<suggested text>","offset":<number>,"length":<number>,"explanation":"<optional>"}], "detectedTone":"<optional tone>", "summary":"<optional one-line summary>"}. ' +
            'Offsets are zero-based character positions in the original text. Length is the number of characters in original. ' +
            `Features to check: ${featureList}.`,
        },
        {
          role: 'user',
          content: request.text,
        },
      ],
    });

    let suggestions: AiWritingSuggestion[] = [];
    let detectedTone: string | null = null;
    let summary: string | null = null;

    try {
      const parsed = JSON.parse(response.content) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.suggestions)) {
        suggestions = parsed.suggestions
          .map((item, index) => normalizeWritingSuggestion(item, index))
          .filter((item): item is AiWritingSuggestion => item !== null);
      }
      if (typeof parsed.detectedTone === 'string') detectedTone = parsed.detectedTone;
      if (typeof parsed.summary === 'string') summary = parsed.summary;
    } catch {
      // Invalid JSON from the provider: drop suggestions rather than crashing.
      // The caller still receives a valid (empty) result and usage is recorded.
      suggestions = [];
    }

    return {
      suggestions,
      detectedTone,
      summary,
      model: response.model,
      usage: response.usage,
    };
  }

  async function rewrite(request: AiRewriteRequest): Promise<AiRewriteResponse> {
    const response = await chatOnce({
      ...request,
      operation: request.operation ?? 'writing_rewrite',
      messages: [
        {
          role: 'system',
          content:
            'You are a writing assistant. Rewrite the user text according to the instruction. ' +
            'Return ONLY a JSON object with this shape: ' +
            '{"text":"<rewritten text>","explanation":"<optional one-line explanation>"}. ' +
            'Do not include markdown fences or commentary outside the JSON object.',
        },
        {
          role: 'user',
          content: `Instruction: ${request.instruction}\n\nText:\n${request.text}`,
        },
      ],
    });

    let text = response.content;
    let explanation: string | null = null;

    try {
      const parsed = JSON.parse(response.content) as Record<string, unknown>;
      if (typeof parsed.text === 'string') text = parsed.text;
      if (typeof parsed.explanation === 'string') explanation = parsed.explanation;
    } catch {
      // If the provider did not return JSON, treat the whole content as the rewrite.
    }

    return {
      text,
      explanation,
      model: response.model,
      usage: response.usage,
    };
  }

  async function health(): Promise<AiHealthStatus> {
    if (!configured) {
      return {
        status: 'down',
        latencyMs: 0,
        error: 'AI provider is disabled or not configured',
      };
    }

    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.aiRequestTimeoutMs);

    try {
      const response = await fetchImpl(`${OPENROUTER_BASE_URL}/auth/key`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${config.openrouterApiKey}`,
        },
        signal: controller.signal,
      });
      const latencyMs = Number((performance.now() - startedAt).toFixed(2));

      if (!response.ok) {
        return {
          status: 'down',
          latencyMs,
          error: `HTTP ${response.status}`,
        };
      }

      return {
        status: 'up',
        latencyMs,
        version: 'openrouter',
      };
    } catch (error) {
      return {
        status: 'down',
        latencyMs: Number((performance.now() - startedAt).toFixed(2)),
        error: controller.signal.aborted
          ? 'Health check timed out'
          : error instanceof Error
            ? error.message
            : 'Health check failed',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    isConfigured(): boolean {
      return configured;
    },

    async chat(request: AiChatRequest, _callOptions?: AiCallOptions): Promise<AiChatResponse> {
      return chat(request);
    },

    async *streamChat(
      request: AiChatRequest,
      callOptions?: AiCallOptions,
    ): AsyncGenerator<AiStreamEvent> {
      yield* streamChat(request, callOptions ?? {});
    },

    async analyzeWriting(
      request: AiWritingRequest,
      _callOptions?: AiCallOptions,
    ): Promise<AiWritingResponse> {
      return analyzeWriting(request);
    },

    async rewrite(
      request: AiRewriteRequest,
      _callOptions?: AiCallOptions,
    ): Promise<AiRewriteResponse> {
      return rewrite(request);
    },

    health,
  };
}
