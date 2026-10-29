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
import { parseAnthropicRateLimitHeaders, recordRateLimit } from './rate-limit.js';
import { anthropicThinkingFields } from '../reasoning-profiles.js';

type AnthropicBlock =
  | { type: 'text'; text: string }
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
    }
  }
  return { system: systemParts.join('\n\n'), messages: out };
}

/**
 * Minimal driver for the Anthropic Messages API.
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

  constructor(
    opts: { baseUrl: string; apiKey: string; authStyle?: 'api-key' | 'bearer'; providerId?: string },
  ) {
    // providerId lets subscription bridges (e.g. claude-subscription) keep
    // their rate-limit snapshots separate from the plain 'anthropic' key.
    this.providerId = opts.providerId ?? 'anthropic';
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.authStyle = opts.authStyle ?? 'api-key';
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
    const { system: rawSystem, messages: anthropicMessages } = toAnthropicMessages(messages);
    // Structured output (Octomind parity): the Messages API has no
    // response_format parameter, so enforcement is an explicit output
    // contract in the system prompt; the runtime additionally validates
    // the JSON and retries once on a parse failure.
    let system = rawSystem;
    if (opts.responseFormat) {
      const contract =
        opts.responseFormat.type === 'json_schema'
          ? 'Your reply must be exactly one JSON value (no prose, no code fences) conforming to this JSON Schema:\n' +
            JSON.stringify(opts.responseFormat.schema)
          : 'Your reply must be exactly one JSON value (no prose, no code fences).';
      system = system ? `${system}\n\n${contract}` : contract;
    }
    let signal = opts.signal;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
      signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    }
    const res = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        ...anthropicThinkingFields(opts.reasoningEffort, opts.maxTokens),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(system ? { system } : {}),
        messages: anthropicMessages,
        ...(tools.length > 0
          ? {
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
      }),
      signal,
    });
    if (!res.ok) {
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
      throw err;
    }
    // Capture the provider's rate-limit/quota headers. Missing headers → no snapshot.
    const rateLimit = parseAnthropicRateLimitHeaders(res.headers);
    if (rateLimit) recordRateLimit(this.providerId, rateLimit);
    const data = (await res.json()) as {
      content?: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      >;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === 'text') {
        textParts.push(block.text);
        opts.onToken?.(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
      }
    }
    const usage: TokenUsage = {
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
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
