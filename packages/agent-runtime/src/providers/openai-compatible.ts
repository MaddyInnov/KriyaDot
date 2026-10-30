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
import { shapeDeepSeekRequest } from './deepseek.js';
import { parseOpenAIRateLimitHeaders, recordRateLimit } from './rate-limit.js';
import { classifyProviderError } from '../failover.js';
import { shapeReasoning } from '../reasoning-profiles.js';

/** Native multimodal content parts (Octomind parity #38). */
type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string } };

interface OpenAIMessage {
  role: string;
  content: string | null | OpenAIContentPart[];
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

/** Default per-call timeout when neither timeoutMs nor replyTimeoutMs is set. */
export const DEFAULT_PROVIDER_TIMEOUT_MS = 300_000;

/**
 * Local endpoints (Ollama / LM Studio on the user's own machine) keep the
 * deliberate unbounded default: a slow local model is the user's call, and
 * the local presets carry their own replyTimeoutMs when built via the
 * factory. The bounded default exists for REMOTE endpoints, where a silent
 * socket otherwise hangs a turn forever (QA 2026-10-30).
 */
export function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '0.0.0.0' ||
      host.endsWith('.local')
    );
  } catch {
    return false;
  }
}

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
    } else if (m.role === 'user' && m.media && m.media.length > 0) {
      // #38: native multimodal turn — text part first, then one part per
      // attachment as a data URI (image_url / video_url), the wire shape
      // OpenAI-compatible vision endpoints accept.
      const parts: OpenAIContentPart[] = [{ type: 'text', text: m.content }];
      for (const media of m.media) {
        const url = `data:${media.mediaType};base64,${media.dataBase64}`;
        parts.push(
          media.kind === 'video'
            ? { type: 'video_url', video_url: { url } }
            : { type: 'image_url', image_url: { url } },
        );
      }
      out.push({ role: 'user', content: parts });
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
  /** Injectable fetch (tests). Default: the global fetch, resolved lazily per call. */
  fetchFn?: typeof fetch;
  /**
   * Keyless lanes (free-LLM stack: LLM7 anonymous): send NO Authorization
   * header at all. The apiKey value is ignored for auth in this mode.
   */
  omitAuthHeader?: boolean;
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
  private readonly fetchFn: typeof fetch;
  private readonly omitAuthHeader: boolean;

  constructor(opts: OpenAICompatibleOptions) {
    this.providerId = opts.providerId;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.defaultModel = opts.defaultModel;
    // Lazy indirection so tests that stub the global fetch AFTER
    // construction still intercept requests.
    this.fetchFn =
      opts.fetchFn ?? (((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch);
    this.omitAuthHeader = opts.omitAuthHeader ?? false;
  }

  private authHeaders(): Record<string, string> {
    return this.omitAuthHeader ? {} : { Authorization: `Bearer ${this.apiKey}` };
  }

  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    onRetry?: (attempt: number, error: Error) => void,
    maxRetries: number = MAX_RETRIES,
  ): Promise<Response> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }
      let res: Response;
      try {
        res = await this.fetchFn(url, init);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries) {
          try {
            onRetry?.(attempt + 1, lastError);
          } catch {
            // Retry notification must never break the retry loop.
          }
        }
        continue; // network error: retry
      }
      if (res.ok) return res;
      let hardLimit = false;
      if (res.status === 429 && attempt < maxRetries) {
        // A hard-quota 429 (insufficient_quota & friends) never clears
        // inside the backoff window — retrying it only delays the
        // failover machinery (QA 2026-10-30: four attempts burned ~4s
        // before failover). Peek at the body via a clone (the throw path
        // below still reads the original) and skip the retry when the
        // error classifies as a usage limit.
        let peek = '';
        try {
          peek = await res.clone().text();
        } catch {
          peek = '';
        }
        if (peek) {
          let code: string | undefined;
          let message = peek.slice(0, 300);
          try {
            const parsed = JSON.parse(peek) as {
              error?: { code?: string; type?: string; message?: string };
            };
            code = parsed.error?.code ?? parsed.error?.type;
            if (parsed.error?.message) message = parsed.error.message;
          } catch {
            // Non-JSON body: classify on the raw text.
          }
          const probe = new Error(message) as Error & { code?: string; status?: number };
          probe.code = code;
          probe.status = 429;
          hardLimit = classifyProviderError(probe, { providerId: this.providerId }).kind === 'limit';
        }
      }
      if (!isRetryable(res.status) || attempt === maxRetries || hardLimit) {
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
      if (attempt < maxRetries) {
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
    opts: Parameters<LLMProvider['chat']>[2],
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: TokenUsage }> {
    // DeepSeek depth (ENGINES pack): an explicit per-bot thinking mode
    // (modelOptions.deepseekMode, threaded as opts.deepseekMode) selects
    // chat vs reasoner BEFORE the generic effort shaping runs. The
    // DeepSeek API expresses effort through that model choice (the
    // reasoner takes no reasoning_effort parameter), so only the model
    // is shaped here; the dsh ACP harness takes a real effort option
    // (see providers/deepseek.ts dshReasoningEffort).
    const deepseekShape =
      this.providerId === 'deepseek' && opts.deepseekMode
        ? shapeDeepSeekRequest(opts.model, {
            deepseekMode: opts.deepseekMode,
            reasoningEffort: opts.reasoningEffort,
          })
        : null;
    const reasoningShaping = shapeReasoning(this.providerId, opts.model, opts.reasoningEffort);
    const body = {
      model: deepseekShape ? deepseekShape.model : (reasoningShaping.model ?? opts.model),
      ...reasoningShaping.body,
      messages: toOpenAIMessages(messages),
      ...(tools.length > 0 ? { tools: toFunctionTools(tools) } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.topP !== undefined ? { top_p: opts.topP } : {}),
      ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
      // Structured output enforcement (Octomind parity): native
      // response_format on the wire. json_schema carries the caller's
      // schema verbatim; strict defaults to true when the caller asked
      // for a schema without saying otherwise.
      ...(opts.responseFormat
        ? {
            response_format:
              opts.responseFormat.type === 'json_object'
                ? { type: 'json_object' }
                : {
                    type: 'json_schema',
                    json_schema: {
                      name: opts.responseFormat.name ?? 'response',
                      schema: opts.responseFormat.schema,
                      strict: opts.responseFormat.strict ?? true,
                    },
                  },
          }
        : {}),
      stream: true,
      stream_options: { include_usage: true },
    };
    // Per-call timeout (purpose-profile knob): combine with the caller's
    // abort signal when both exist. The local drivers' replyTimeoutMs
    // (ENGINES pack, from bot modelOptions) is the fallback when no
    // explicit per-call timeout was given. When neither is set, a default
    // ceiling applies to REMOTE endpoints (QA 2026-10-30): a cloud endpoint
    // that accepts the connection and never replies otherwise hangs the
    // turn forever. LOCAL endpoints (Ollama/LM Studio on the user's own
    // machine) stay unbounded by design — a slow local model is the user's
    // call, and the local presets carry replyTimeoutMs when factory-built.
    // Callers needing longer (huge generations) raise replyTimeoutMs.
    let signal = opts.signal;
    const effectiveTimeoutMs =
      opts.timeoutMs ??
      opts.replyTimeoutMs ??
      (isLocalBaseUrl(this.baseUrl) ? undefined : DEFAULT_PROVIDER_TIMEOUT_MS);
    if (effectiveTimeoutMs && effectiveTimeoutMs > 0) {
      const timeoutSignal = AbortSignal.timeout(effectiveTimeoutMs);
      signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    }
    const res = await this.fetchWithRetry(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
      signal,
    }, opts.onRetry, opts.maxRetries);

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
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
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
            // Prompt-cache reads (#137): OpenAI reports them under
            // prompt_tokens_details.cached_tokens.
            ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined
              ? { cacheReadTokens: chunk.usage.prompt_tokens_details.cached_tokens }
              : {}),
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
      const res = await this.fetchFn(`${this.baseUrl}/models`, {
        headers: { ...this.authHeaders(), ...this.extraHeaders },
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
