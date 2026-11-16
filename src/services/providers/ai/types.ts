/**
 * Boundary types for the optional Python/FastAPI AI service.
 *
 * Express owns authentication, authorisation and context preparation. The AI
 * service receives only already-authorised context and returns suggestions or
 * proposed actions. It never mutates the Nexus database directly.
 */

export type AiMessageRole = 'system' | 'user' | 'assistant';

export interface AiChatMessage {
  role: AiMessageRole;
  content: string;
}

export interface AiSourceReference {
  type: string;
  id: string;
  title: string;
  workspaceId?: string | null;
  projectId?: string | null;
  /** Short, permission-filtered excerpt used by the model. */
  snippet?: string;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiChatRequest {
  messages: AiChatMessage[];
  context?: AiSourceReference[];
  workspaceId?: string | null;
  conversationId?: string | null;
  operation: string;
  model?: string | null;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface AiChatResponse {
  content: string;
  model: string;
  usage: AiUsage;
  references: AiSourceReference[];
  finishReason?: string;
}

export type AiStreamEvent =
  | { type: 'token'; content: string }
  | { type: 'references'; references: AiSourceReference[] }
  | { type: 'done'; response: AiChatResponse }
  | { type: 'error'; code: string; message: string };

export type WritingSuggestionCategory =
  'SPELLING' | 'GRAMMAR' | 'PUNCTUATION' | 'CLARITY' | 'VOCABULARY' | 'TONE' | 'STYLE';

export interface AiWritingSuggestion {
  id: string;
  category: WritingSuggestionCategory;
  severity: 'low' | 'medium' | 'high';
  message: string;
  original: string;
  replacement: string;
  offset: number;
  length: number;
  explanation?: string;
}

export interface AiWritingRequest {
  text: string;
  features: string[];
  language?: string;
  toneTarget?: string;
  workspaceId?: string | null;
  operation?: string;
}

export interface AiWritingResponse {
  suggestions: AiWritingSuggestion[];
  detectedTone?: string | null;
  summary?: string | null;
  model: string;
  usage: AiUsage;
}

export interface AiRewriteRequest {
  text: string;
  instruction: string;
  tone?: string;
  workspaceId?: string | null;
  operation?: string;
}

export interface AiRewriteResponse {
  text: string;
  explanation?: string | null;
  model: string;
  usage: AiUsage;
}

export interface AiHealthStatus {
  status: 'up' | 'down';
  latencyMs: number;
  version?: string;
  error?: string;
}

export interface AiClient {
  /** True when the service is enabled and fully configured. */
  isConfigured(): boolean;
  chat(request: AiChatRequest, options?: AiCallOptions): Promise<AiChatResponse>;
  streamChat(request: AiChatRequest, options?: AiCallOptions): AsyncGenerator<AiStreamEvent>;
  analyzeWriting(request: AiWritingRequest, options?: AiCallOptions): Promise<AiWritingResponse>;
  rewrite(request: AiRewriteRequest, options?: AiCallOptions): Promise<AiRewriteResponse>;
  health(): Promise<AiHealthStatus>;
}

export interface AiCallOptions {
  signal?: AbortSignal;
  requestId?: string;
}

export class AiUnavailableError extends Error {
  readonly code: string;

  constructor(message = 'The AI service is unavailable', code = 'AI_UNAVAILABLE') {
    super(message);
    this.name = 'AiUnavailableError';
    this.code = code;
  }
}

export class AiProviderError extends Error {
  readonly code: string;
  readonly statusCode?: number;

  constructor(message: string, code = 'AI_PROVIDER_ERROR', statusCode?: number) {
    super(message);
    this.name = 'AiProviderError';
    this.code = code;
    this.statusCode = statusCode;
  }
}
