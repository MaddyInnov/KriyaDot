// SPDX-License-Identifier: Apache-2.0

import type {
  ChatMessage,
  LLMProvider,
  ModelInfo,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '../types.js';
import { getMessageToolCalls } from '../types.js';
import { getDefaultModel, getProviderPreset } from './catalog.js';
import { parseOpenAIRateLimitHeaders, recordRateLimit } from './rate-limit.js';

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

interface SSEToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId });
    } else if (m.role === 'assistant') {
      const toolCalls = getMessageToolCalls(m);
      out.push({
        role: 'assistant',
        content: m.content,
        ...(toolCalls && toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.args) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function toFunctionTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export interface OpenAICompatibleOptions {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  extraHeaders?: Record<string, string>;
  defaultModel?: string;
}

/**
 * Driver for OpenAI-compatible chat-completions endpoints (Groq, OpenRouter,
 * OpenAI, and BYO presets like OmniRush). Streams via SSE.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly providerId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly defaultModel?: string;

  constructor(opts: OpenAICompatibleOptions) {
    this.providerId = opts.providerId;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.defaultModel = opts.defaultModel;
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    onRetry?: (attempt: number, error: Error) => void,
  ): Promise<Response> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_RETRIES) {
          try {
            onRetry?.(attempt + 1, lastError);
          } catch {
            // Retry notification must never break the retry loop.
          }
        }
        continue; // network error: retry
      }
      if (res.ok) return res;
      if (!isRetryable(res.status) || attempt === MAX_RETRIES) {
        const body = await res.text().catch(() => '');
        // Rate-limit headers ride along on error responses too — record
        // the snapshot so near-limit warnings + failover reset times work
        // even when the call itself was refused.
        const errSnap = parseOpenAIRateLimitHeaders(res.headers);
        if (errSnap) recordRateLimit(this.providerId, errSnap);
        const err = new Error(
          `Provider request failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`,
        ) as Error & { status?: number; code?: string; retryAfterMs?: number; resetAt?: string };
        err.status = res.status;
        const retryAfter = res.headers.get('retry-after');
        if (retryAfter) {
          const secs = Number(retryAfter);
          if (Number.isFinite(secs)) err.retryAfterMs = secs * 1000;
        }
        if (errSnap?.resetAt) err.resetAt = errSnap.resetAt;
        try {
          const parsed = JSON.parse(body) as { error?: { code?: string; type?: string } };
          const code = parsed.error?.code ?? parsed.error?.type;
          if (typeof code === 'string' && code) err.code = code;
        } catch {
          // Non-JSON body: the message text still carries the semantics.
        }
        throw err;
      }
      lastError = new Error(`Provider request failed: ${res.status}`);
      if (attempt < MAX_RETRIES) {
        try {
          onRetry?.(attempt + 1, lastError);
        } catch {
          // Retry notification must never break the retry loop.
        }
      }
      await res.arrayBuffer().catch(() => undefined); // drain
    }
    throw lastError ?? new Error('Provider request failed after retries');
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: { model: string; onToken?: (t: string) => void; signal?: AbortSignal; onRetry?: (attempt: number, error: Error) => void; reasoningEffort?: 'low' | 'medium' | 'high' },
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: TokenUsage }> {
    const body = {
      model: opts.model,
      messages: toOpenAIMessages(messages),
      ...(tools.length > 0 ? { tools: toFunctionTools(tools) } : {}),
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      stream: true,
      stream_options: { include_usage: true },
    };
    const res = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    }, opts.onRetry);

    // Capture the provider's rate-limit/quota headers (Groq, OpenAI,
    // OpenRouter all send x-ratelimit-*). Missing headers → no snapshot.
    const rateLimit = parseOpenAIRateLimitHeaders(res.headers);
    if (rateLimit) recordRateLimit(this.providerId, rateLimit);

    const contentParts: string[] = [];
    const toolCallDeltas = new Map<number, { id: string; name: string; args: string }>();
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    if (!res.body) throw new Error('Provider returned an empty response body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk: {
          choices?: Array<{
            delta?: { content?: string | null; tool_calls?: SSEToolCallDelta[] };
            finish_reason?: string | null;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        };
        try {
          chunk = JSON.parse(data) as typeof chunk;
        } catch {
          continue;
        }
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          contentParts.push(delta.content);
          opts.onToken?.(delta.content);
        }
        for (const tc of delta?.tool_calls ?? []) {
          const existing = toolCallDeltas.get(tc.index) ?? { id: '', name: '', args: '' };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.name += tc.function.name;
          if (tc.function?.arguments) existing.args += tc.function.arguments;
          toolCallDeltas.set(tc.index, existing);
        }
        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens ?? 0,
          };
        }
      }
    }

    const toolCalls: ToolCall[] = [...toolCallDeltas.values()]
      .filter((tc) => tc.id && tc.name)
      .map((tc, i) => {
        let args: Record<string, unknown> = {};
        try {
          args = tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {};
        } catch {
          args = { _raw: tc.args };
        }
        return { id: tc.id || `call_${i}`, name: tc.name, args };
      });

    return { content: contentParts.join(''), toolCalls, usage };
  }

  async listModels(): Promise<ModelInfo[]> {
    const preset = getProviderPreset(this.providerId);
    // BYO presets with no configured endpoint: nothing to query, return the
    // (empty) catalog list instead of failing.
    if (!this.baseUrl) {
      return (preset?.models ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        contextLength: m.contextLength,
      }));
    }
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}`, ...this.extraHeaders },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { data?: Array<{ id: string; context_length?: number }> };
      if (Array.isArray(data.data)) {
        return data.data.map((m) => ({ id: m.id, name: m.id, contextLength: m.context_length }));
      }
      throw new Error('Unexpected /models response shape');
    } catch {
      // Fall back to the catalog list (used by OpenRouter when live fetch fails).
      const fallbackId = this.defaultModel ?? getDefaultModel(this.providerId);
      const catalogModels = (preset?.models ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        contextLength: m.contextLength,
      }));
      if (catalogModels.length > 0) return catalogModels;
      return fallbackId ? [{ id: fallbackId, name: fallbackId }] : [];
    }
  }
}
