import type { AppConfig } from '../../../config/env';
import { logger as defaultLogger, type Logger } from '../../../utils/logger';
import { CircuitBreaker } from './circuit-breaker';
import {
  AiProviderError,
  AiUnavailableError,
  type AiCallOptions,
  type AiChatResponse,
  type AiClient,
  type AiHealthStatus,
  type AiRewriteResponse,
  type AiSourceReference,
  type AiStreamEvent,
  type AiUsage,
  type AiWritingResponse,
  type AiWritingSuggestion,
} from './types';

export type AiClientConfig = Pick<
  AppConfig,
  | 'aiEnabled'
  | 'aiServiceUrl'
  | 'aiServiceToken'
  | 'aiModel'
  | 'aiRequestTimeoutMs'
  | 'aiStreamTimeoutMs'
  | 'aiCircuitBreakerFailures'
  | 'aiCircuitBreakerResetMs'
>;

export interface AiClientOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

interface AiServiceErrorBody {
  error?: { code?: unknown; message?: unknown };
  code?: unknown;
  message?: unknown;
}

const MAX_ERROR_LENGTH = 300;

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

function normalizeReferences(value: unknown): AiSourceReference[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .filter((item) => typeof item.type === 'string' && typeof item.id === 'string')
    .map((item) => ({
      type: String(item.type),
      id: String(item.id),
      title: typeof item.title === 'string' ? item.title : String(item.id),
      workspaceId: typeof item.workspaceId === 'string' ? item.workspaceId : null,
      projectId: typeof item.projectId === 'string' ? item.projectId : null,
      ...(typeof item.snippet === 'string' ? { snippet: item.snippet } : {}),
    }));
}

function normalizeChatResponse(body: unknown): AiChatResponse {
  if (!body || typeof body !== 'object') {
    throw new AiProviderError('The AI service returned an invalid response', 'AI_INVALID_RESPONSE');
  }

  const value = body as Record<string, unknown>;
  const content = typeof value.content === 'string' ? value.content : '';
  if (!content.trim()) {
    throw new AiProviderError('The AI service returned an empty response', 'AI_EMPTY_RESPONSE');
  }

  return {
    content,
    model: typeof value.model === 'string' ? value.model : 'unknown',
    usage: normalizeUsage(value.usage),
    references: normalizeReferences(value.references),
    ...(typeof value.finishReason === 'string' ? { finishReason: value.finishReason } : {}),
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

function normalizeWritingResponse(body: unknown, model: string): AiWritingResponse {
  if (!body || typeof body !== 'object') {
    throw new AiProviderError('The AI service returned an invalid response', 'AI_INVALID_RESPONSE');
  }
  const value = body as Record<string, unknown>;
  const suggestions = Array.isArray(value.suggestions)
    ? value.suggestions
        .map((item, index) => normalizeWritingSuggestion(item, index))
        .filter((item): item is AiWritingSuggestion => item !== null)
    : [];

  return {
    suggestions,
    detectedTone: typeof value.detectedTone === 'string' ? value.detectedTone : null,
    summary: typeof value.summary === 'string' ? value.summary : null,
    model: typeof value.model === 'string' ? value.model : model,
    usage: normalizeUsage(value.usage),
  };
}

function normalizeRewriteResponse(body: unknown, model: string): AiRewriteResponse {
  if (!body || typeof body !== 'object') {
    throw new AiProviderError('The AI service returned an invalid response', 'AI_INVALID_RESPONSE');
  }
  const value = body as Record<string, unknown>;
  if (typeof value.text !== 'string') {
    throw new AiProviderError('The AI service returned an invalid rewrite', 'AI_INVALID_RESPONSE');
  }

  return {
    text: value.text,
    explanation: typeof value.explanation === 'string' ? value.explanation : null,
    model: typeof value.model === 'string' ? value.model : model,
    usage: normalizeUsage(value.usage),
  };
}

function errorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const value = body as AiServiceErrorBody;
  const nested = value.error;
  const message =
    (nested && typeof nested.message === 'string' && nested.message) ||
    (typeof value.message === 'string' && value.message) ||
    fallback;
  return message.slice(0, MAX_ERROR_LENGTH);
}

function errorCode(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const value = body as AiServiceErrorBody;
  const nested = value.error;
  if (nested && typeof nested.code === 'string' && nested.code) return nested.code;
  return typeof value.code === 'string' && value.code ? value.code : fallback;
}

/**
 * HTTP client for the Python/FastAPI AI service.
 *
 * Every request carries the shared service token. User credentials are never
 * forwarded: the AI service authenticates the *backend*, not the end user,
 * and Express has already evaluated all permissions before calling it.
 */
export function createAiClient(config: AiClientConfig, options: AiClientOptions = {}): AiClient {
  const logger = options.logger ?? defaultLogger;
  const fetchImpl = options.fetchImpl ?? fetch;
  const breaker = new CircuitBreaker(
    config.aiCircuitBreakerFailures,
    config.aiCircuitBreakerResetMs,
  );

  const configured = Boolean(
    config.aiEnabled && config.aiServiceUrl.trim() && config.aiServiceToken.trim(),
  );

  function ensureConfigured(): void {
    if (!configured) {
      throw new AiUnavailableError(
        'The AI service is not configured. Set AI_ENABLED, AI_SERVICE_URL and AI_SERVICE_TOKEN.',
        'AI_NOT_CONFIGURED',
      );
    }
    if (!breaker.allowRequest()) {
      throw new AiUnavailableError(
        'The AI service is temporarily unavailable. Please try again shortly.',
        'AI_CIRCUIT_OPEN',
      );
    }
  }

  async function requestJson<T>(
    path: string,
    body: unknown,
    timeoutMs: number,
    callOptions: AiCallOptions = {},
  ): Promise<T> {
    ensureConfigured();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    callOptions.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await fetchImpl(`${config.aiServiceUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${config.aiServiceToken}`,
          'x-nexus-service': 'backend',
          ...(callOptions.requestId ? { 'x-request-id': callOptions.requestId } : {}),
        },
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
        const message = errorMessage(parsed, `The AI service returned HTTP ${response.status}`);
        breaker.onFailure();
        logger.warn('ai_service_request_failed', {
          path,
          statusCode: response.status,
          code,
        });
        throw new AiProviderError(message, code, response.status);
      }

      breaker.onSuccess();
      return parsed as T;
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      breaker.onFailure();
      const timedOut = controller.signal.aborted && !callOptions.signal?.aborted;
      logger.warn('ai_service_unreachable', {
        path,
        timedOut,
        error,
      });
      throw new AiUnavailableError(
        timedOut ? 'The AI service did not respond in time' : 'The AI service could not be reached',
        timedOut ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE',
      );
    } finally {
      clearTimeout(timer);
      callOptions.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async function* parseEventStream(
    response: Response,
    model: string,
  ): AsyncGenerator<AiStreamEvent> {
    if (!response.body) {
      throw new AiProviderError('The AI service returned an empty stream', 'AI_EMPTY_RESPONSE');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalResponse: AiChatResponse | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split(/\n\n/);
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const dataLines = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());
          if (dataLines.length === 0) continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
          } catch {
            continue;
          }

          const type = event.type;
          if (type === 'token' && typeof event.content === 'string') {
            yield { type: 'token', content: event.content };
          } else if (type === 'references') {
            yield { type: 'references', references: normalizeReferences(event.references) };
          } else if (type === 'error') {
            yield {
              type: 'error',
              code: typeof event.code === 'string' ? event.code : 'AI_PROVIDER_ERROR',
              message: typeof event.message === 'string' ? event.message : 'AI stream failed',
            };
            return;
          } else if (type === 'done') {
            finalResponse = normalizeChatResponse(event.response ?? { model, content: '' });
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (finalResponse) {
      yield { type: 'done', response: finalResponse };
    } else {
      throw new AiProviderError('The AI stream ended without a result', 'AI_INCOMPLETE_STREAM');
    }
  }

  return {
    isConfigured(): boolean {
      return configured;
    },

    async chat(request, callOptions = {}) {
      const body = {
        ...request,
        model: request.model ?? config.aiModel ?? undefined,
      };
      const response = await requestJson<unknown>(
        '/v1/chat',
        body,
        config.aiRequestTimeoutMs,
        callOptions,
      );
      return normalizeChatResponse(response);
    },

    async *streamChat(request, callOptions = {}) {
      ensureConfigured();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.aiStreamTimeoutMs);
      const onExternalAbort = () => controller.abort();
      callOptions.signal?.addEventListener('abort', onExternalAbort, { once: true });

      try {
        const response = await fetchImpl(`${config.aiServiceUrl}/v1/chat/stream`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${config.aiServiceToken}`,
            'x-nexus-service': 'backend',
            ...(callOptions.requestId ? { 'x-request-id': callOptions.requestId } : {}),
          },
          body: JSON.stringify({
            ...request,
            model: request.model ?? config.aiModel ?? undefined,
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
            errorMessage(parsed, `The AI service returned HTTP ${response.status}`),
            errorCode(parsed, `AI_HTTP_${response.status}`),
            response.status,
          );
        }

        breaker.onSuccess();
        yield* parseEventStream(response, config.aiModel || 'unknown');
      } catch (error) {
        if (error instanceof AiProviderError || error instanceof AiUnavailableError) throw error;
        breaker.onFailure();
        throw new AiUnavailableError(
          'The AI stream could not be completed',
          controller.signal.aborted ? 'AI_TIMEOUT' : 'AI_UNAVAILABLE',
        );
      } finally {
        clearTimeout(timer);
        callOptions.signal?.removeEventListener('abort', onExternalAbort);
      }
    },

    async analyzeWriting(request, callOptions = {}) {
      const response = await requestJson<unknown>(
        '/v1/writing/analyze',
        request,
        config.aiRequestTimeoutMs,
        callOptions,
      );
      return normalizeWritingResponse(response, config.aiModel || 'unknown');
    },

    async rewrite(request, callOptions = {}) {
      const response = await requestJson<unknown>(
        '/v1/writing/rewrite',
        request,
        config.aiRequestTimeoutMs,
        callOptions,
      );
      return normalizeRewriteResponse(response, config.aiModel || 'unknown');
    },

    async health(): Promise<AiHealthStatus> {
      if (!configured) {
        return {
          status: 'down',
          latencyMs: 0,
          error: 'AI service is disabled or not configured',
        };
      }

      const startedAt = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.aiRequestTimeoutMs);

      try {
        const response = await fetchImpl(`${config.aiServiceUrl}/health`, {
          headers: {
            authorization: `Bearer ${config.aiServiceToken}`,
            'x-nexus-service': 'backend',
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

        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        return {
          status: 'up',
          latencyMs,
          ...(typeof body.version === 'string' ? { version: body.version } : {}),
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
    },
  };
}
