// SPDX-License-Identifier: Apache-2.0

import type {
  ChatMessage,
  LLMProvider,
  ModelInfo,
  StructuredOutputSpec,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '../types.js';
import { getMessageToolCalls } from '../types.js';
import { parseAnthropicRateLimitHeaders, recordRateLimit } from './rate-limit.js';
import { anthropicThinkingFields } from '../reasoning-profiles.js';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: AnthropicMessage[] } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];

  const pushBlock = (role: 'user' | 'assistant', block: AnthropicBlock): void => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(block);
    } else {
      out.push({ role, content: [block] });
    }
  };

  for (const m of messages) {
    if (m.role === 'system') {
      systemParts.push(m.content);
    } else if (m.role === 'tool') {
      pushBlock('user', {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
      });
    } else if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of getMessageToolCalls(m) ?? []) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      const last = out[out.length - 1];
      if (last && last.role === 'assistant') {
        last.content.push(...blocks);
      } else {
        out.push({ role: 'assistant', content: blocks });
      }
    } else {
      pushBlock('user', { type: 'text', text: m.content });
      // #38: native image parts as base64 image blocks. The Messages API
      // has no video input, so video attachments degrade to an explicit
      // note rather than being silently dropped.
      for (const media of m.media ?? []) {
        if (media.kind === 'image') {
          pushBlock('user', {
            type: 'image',
            source: { type: 'base64', media_type: media.mediaType, data: media.dataBase64 },
          });
        } else {
          pushBlock('user', {
            type: 'text',
            text: `[A ${media.mediaType} video was attached, but this model cannot view video input.]`,
          });
        }
      }
    }
  }
  return { system: systemParts.join('\n\n'), messages: out };
}

/**
 * Name of the forced tool used for native structured output (parity
 * #108). The Messages API has no `response_format` parameter; the
 * driver's native mechanism is a forced tool call: when a call carries
 * a responseFormat spec, the driver declares this extra tool whose
 * input_schema IS the requested JSON Schema and forces the model to
 * call it (`tool_choice: {type:'tool', name:'__structured_output'}`).
 * The tool call's input is then returned as the reply content (JSON),
 * never surfaced as a runtime tool call. A structured call is therefore
 * a final-answer call: user tools are still declared, but the forced
 * choice means the model answers with the structured tool instead of
 * calling them on that turn.
 */
export const STRUCTURED_OUTPUT_TOOL_NAME = '__structured_output';

/** Build the forced structured-output tool declaration for a spec. */
export function buildAnthropicStructuredTool(spec: StructuredOutputSpec): {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
} {
  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description:
      'Return the final answer as structured data conforming to the input schema. ' +
      'Call this tool exactly once with the complete answer as its input.',
    input_schema:
      spec.type === 'json_schema'
        ? spec.schema
        : { type: 'object', additionalProperties: true },
  };
}

const MAX_RETRIES_DEFAULT = 3;
const BASE_BACKOFF_MS = 500;

function sleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * Driver for the Anthropic Messages API.
 *
 * Per-profile retry/timeout controls (parity #11): `opts.maxRetries`
 * (default 3) retries 429/408/5xx and network errors with exponential
 * backoff (honoring `retry-after`), and `opts.timeoutMs` bounds the
 * whole call via an AbortSignal combined with the caller's signal.
 * Aborts (caller or timeout) are never retried.
 */
export class AnthropicProvider implements LLMProvider {
  readonly providerId: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  /**
   * 'api-key' sends x-api-key (Anthropic API keys). 'bearer' sends
   * Authorization: Bearer + the oauth beta header — the wire format Claude
   * Code uses for Claude subscription (OAuth) tokens.
   */
  private readonly authStyle: 'api-key' | 'bearer';
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    opts: {
      baseUrl: string;
      apiKey: string;
      authStyle?: 'api-key' | 'bearer';
      providerId?: string;
      /** Injectable fetch (tests). Default: global fetch, resolved lazily. */
      fetchFn?: typeof fetch;
      /** Injectable backoff sleep (tests). */
      sleepFn?: (ms: number) => Promise<void>;
    },
  ) {
    // providerId lets subscription bridges (e.g. claude-subscription) keep
    // their rate-limit snapshots separate from the plain 'anthropic' key.
    this.providerId = opts.providerId ?? 'anthropic';
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.authStyle = opts.authStyle ?? 'api-key';
    this.fetchFn =
      opts.fetchFn ?? (((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch);
    this.sleepFn = opts.sleepFn ?? sleepDefault;
  }

  private authHeaders(): Record<string, string> {
    if (this.authStyle === 'bearer') {
      return {
        Authorization: `Bearer ${this.apiKey}`,
        'anthropic-beta': 'oauth-2025-04-20',
      };
    }
    return { 'x-api-key': this.apiKey };
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: Parameters<LLMProvider['chat']>[2],
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: TokenUsage }> {
    const { system, messages: anthropicMessages } = toAnthropicMessages(messages);
    // Structured output (parity #108): native forced-tool mechanism —
    // see STRUCTURED_OUTPUT_TOOL_NAME above. No prompt-append contract
    // is used on this driver anymore.
    const wireTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
    if (opts.responseFormat) {
      wireTools.push(buildAnthropicStructuredTool(opts.responseFormat));
    }
    let signal = opts.signal;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
      signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    }
    const requestBody = JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      ...anthropicThinkingFields(opts.reasoningEffort, opts.maxTokens),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(system ? { system } : {}),
      messages: anthropicMessages,
      ...(wireTools.length > 0 ? { tools: wireTools } : {}),
      ...(opts.responseFormat
        ? { tool_choice: { type: 'tool', name: STRUCTURED_OUTPUT_TOOL_NAME } }
        : {}),
    });
    const maxRetries = Math.max(0, Math.floor(opts.maxRetries ?? MAX_RETRIES_DEFAULT));
    let res: Response | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        res = await this.fetchFn(`${this.baseUrl}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.authHeaders(),
            'anthropic-version': '2023-06-01',
          },
          body: requestBody,
          signal,
        });
      } catch (err) {
        // Aborts (caller signal or the timeout signal) are final.
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
        if (attempt >= maxRetries) throw err;
        const lastError = err instanceof Error ? err : new Error(String(err));
        try {
          opts.onRetry?.(attempt + 1, lastError);
        } catch {
          // Retry notification must never break the retry loop.
        }
        await this.sleepFn(BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      if (res.ok) break;
      const body = await res.text().catch(() => '');
      const errSnap = parseAnthropicRateLimitHeaders(res.headers);
      if (errSnap) recordRateLimit(this.providerId, errSnap);
      const err = new Error(
        `Anthropic request failed: ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ''}`,
      ) as Error & { status?: number; code?: string; retryAfterMs?: number; resetAt?: string };
      err.status = res.status;
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) {
        const secs = Number(retryAfter);
        if (Number.isFinite(secs)) err.retryAfterMs = secs * 1000;
      }
      if (errSnap?.resetAt) err.resetAt = errSnap.resetAt;
      try {
        const parsed = JSON.parse(body) as { error?: { type?: string } };
        if (typeof parsed.error?.type === 'string' && parsed.error.type) err.code = parsed.error.type;
      } catch {
        // Non-JSON body: message text still carries the semantics.
      }
      if (!isRetryableStatus(res.status) || attempt >= maxRetries) throw err;
      try {
        opts.onRetry?.(attempt + 1, err);
      } catch {
        // Retry notification must never break the retry loop.
      }
      await this.sleepFn(err.retryAfterMs ?? BASE_BACKOFF_MS * 2 ** attempt);
      res = undefined;
    }
    if (!res) throw new Error('Anthropic request failed after retries');
    // Capture the provider's rate-limit/quota headers. Missing headers → no snapshot.
    const rateLimit = parseAnthropicRateLimitHeaders(res.headers);
    if (rateLimit) recordRateLimit(this.providerId, rateLimit);
    const data = (await res.json()) as {
      content?: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      >;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
      };
    };
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === 'text') {
        textParts.push(block.text);
        opts.onToken?.(block.text);
      } else if (block.type === 'tool_use') {
        if (opts.responseFormat && block.name === STRUCTURED_OUTPUT_TOOL_NAME) {
          // Native structured output: the forced tool's input IS the
          // reply. Surface it as content (JSON), not as a tool call.
          const json = JSON.stringify(block.input ?? {});
          textParts.push(json);
          opts.onToken?.(json);
        } else {
          toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
        }
      }
    }
    const usage: TokenUsage = {
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      // Prompt-cache buckets (#137): reported by the Messages API when
      // cache_control is in play; absent otherwise.
      ...(data.usage?.cache_read_input_tokens !== undefined
        ? { cacheReadTokens: data.usage.cache_read_input_tokens }
        : {}),
      ...(data.usage?.cache_creation_input_tokens !== undefined
        ? { cacheWriteTokens: data.usage.cache_creation_input_tokens }
        : {}),
    };
    return { content: textParts.join(''), toolCalls, usage };
  }

  async listModels(): Promise<ModelInfo[]> {
    // The Messages API has no public models endpoint; return the catalog list.
    const { getProviderPreset } = await import('./catalog.js');
    const preset = getProviderPreset('anthropic');
    return (preset?.models ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.contextLength,
    }));
  }
}
