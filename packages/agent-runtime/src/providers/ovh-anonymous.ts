// SPDX-License-Identifier: Apache-2.0
/**
 * OVHcloud AI Endpoints — ANONYMOUS keyless driver (free-LLM stack #1).
 *
 * OVHcloud's official getting-started docs publish an anonymous tier for
 * AI Endpoints: 2 requests/minute per IP **per model**, OpenAI-compatible
 * (https://docs.ovhcloud.com/en/guides/public-cloud/ai-machine-learning/ai-endpoints-getting-started).
 * No API key exists on this lane and NONE is sent — this driver never
 * emits an Authorization header.
 *
 * Because the cap is per model, the driver keeps a small rotation of
 * catalog models and tracks each model's last-call timestamp in-process:
 * a model called inside the pacing window is skipped while a fresher
 * model exists, and a 429 rotates to the next model instead of surfacing
 * as a dead end. Shared lane — modest limits, prompts leave the device.
 */

import type {
  ChatMessage,
  LLMProvider,
  ModelInfo,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '../types.js';
import { getMessageToolCalls } from '../types.js';

export const OVH_ANONYMOUS_BASE_URL = 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1';

/** Catalog model ids on the anonymous lane (gpt-oss / Qwen3 / Llama 3.3 class). */
export const OVH_ANONYMOUS_MODELS: readonly string[] = [
  'gpt-oss-120b',
  'Qwen3-32B',
  'Meta-Llama-3_3-70B-Instruct',
];

/** 2 requests/min per model ⇒ one call per model per 30 s window. */
export const OVH_ANONYMOUS_MIN_INTERVAL_MS = 30_000;

export interface OvAnonymousOptions {
  baseUrl?: string;
  models?: readonly string[];
  fetchFn?: typeof fetch;
  /** Clock override (tests). */
  now?: () => number;
  minIntervalMs?: number;
}

interface OpenAIMessageShape {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessageShape[] {
  const out: OpenAIMessageShape[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId });
    } else if (m.role === 'assistant') {
      const calls = getMessageToolCalls(m);
      out.push({
        role: 'assistant',
        content: m.content,
        ...(calls && calls.length > 0
          ? {
              tool_calls: calls.map((tc) => ({
                id: tc.id,
                type: 'function' as const,
                function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
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

export class OvAnonymousProvider implements LLMProvider {
  readonly providerId = 'ovh-anonymous';
  private readonly baseUrl: string;
  private readonly models: readonly string[];
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  /** Per-model last-call timestamps (in-process pacing state). */
  private readonly lastCallByModel = new Map<string, number>();

  constructor(opts: OvAnonymousOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? OVH_ANONYMOUS_BASE_URL).replace(/\/+$/, '');
    this.models = opts.models ?? OVH_ANONYMOUS_MODELS;
    this.fetchFn =
      opts.fetchFn ?? (((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch);
    this.now = opts.now ?? (() => Date.now());
    this.minIntervalMs = opts.minIntervalMs ?? OVH_ANONYMOUS_MIN_INTERVAL_MS;
  }

  /** Models in the order this call should try them (pacing-aware). */
  private rotationOrder(requested: string): string[] {
    const now = this.now();
    const candidates = [...new Set([requested, ...this.models])];
    const fresh = candidates.filter((m) => {
      const last = this.lastCallByModel.get(m);
      return last === undefined || now - last >= this.minIntervalMs;
    });
    // Prefer fresh models; if every model is inside its pacing window,
    // fall back to least-recently-called order rather than blocking.
    const stale = candidates
      .filter((m) => !fresh.includes(m))
      .sort((a, b) => (this.lastCallByModel.get(a) ?? 0) - (this.lastCallByModel.get(b) ?? 0));
    return [...fresh, ...stale];
  }

  /** Last-call timestamp for a model (diagnostics/tests). */
  lastCallAt(model: string): number | undefined {
    return this.lastCallByModel.get(model);
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: Parameters<LLMProvider['chat']>[2],
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: TokenUsage }> {
    let signal = opts.signal;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
      signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    }
    const order = this.rotationOrder(opts.model);
    let lastError: Error | null = null;
    for (let i = 0; i < order.length; i++) {
      const model = order[i]!;
      this.lastCallByModel.set(model, this.now());
      const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Keyless lane: deliberately NO Authorization header.
        },
        body: JSON.stringify({
          model,
          messages: toOpenAIMessages(messages),
          ...(tools.length > 0
            ? {
                tools: tools.map((t) => ({
                  type: 'function',
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
              }
            : {}),
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
          stream: false,
        }),
        signal,
      });
      if (res.status === 429 && i < order.length - 1) {
        // Per-model cap hit — rotate to the next model (pacing state
        // above already marks this model as just-used).
        lastError = new Error(
          `OVHcloud anonymous lane rate-limited model "${model}" (429); rotating to the next model.`,
        );
        try {
          opts.onRetry?.(i + 1, lastError);
        } catch {
          // Retry notification must never break rotation.
        }
        await res.text().catch(() => '');
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(
          `OVHcloud AI Endpoints (anonymous) request failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ''}`,
        ) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      const data = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const message = data.choices?.[0]?.message;
      const content = message?.content ?? '';
      if (content) opts.onToken?.(content);
      const toolCalls: ToolCall[] = [];
      for (const tc of message?.tool_calls ?? []) {
        if (!tc.function?.name) continue;
        let args: Record<string, unknown> = {};
        try {
          args = tc.function.arguments
            ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
            : {};
        } catch {
          args = { _raw: tc.function.arguments ?? '' };
        }
        toolCalls.push({ id: tc.id ?? `call_${toolCalls.length}`, name: tc.function.name, args });
      }
      const usage: TokenUsage = {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens:
          data.usage?.total_tokens ??
          (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0),
      };
      return { content, toolCalls, usage };
    }
    throw lastError ?? new Error('OVHcloud anonymous lane exhausted all rotation models.');
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.models.map((id) => ({ id, name: id, free: true }));
  }
}
