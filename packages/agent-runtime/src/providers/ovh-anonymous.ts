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
  'Qwen3.6-27B',
  'Meta-Llama-3_3-70B-Instruct',
];

/** 2 requests/min per model ⇒ one call per model per 30 s window. */
export const OVH_ANONYMOUS_MIN_INTERVAL_MS = 30_000;

/** Default per-call timeout when the caller sets none (bounds silent hangs). */
export const OVH_DEFAULT_TIMEOUT_MS = 60_000;

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
  /**
   * Models that answered 404 (not served on the anonymous lane). They are
   * skipped by later rotations in this process: the anonymous catalog and
   * the models actually served can drift (QA 2026-10-30: Qwen3-32B was
   * listed but OVH answered model_not_found), and re-asking a dead model
   * first on every call wastes the turn.
   */
  private readonly unavailableModels = new Set<string>();

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
    const all = [...new Set([requested, ...this.models])];
    // Skip models known-unavailable on this lane, unless that would leave
    // nothing to try (the lane may have started serving them again).
    const live = all.filter((m) => !this.unavailableModels.has(m));
    const candidates = live.length > 0 ? live : all;
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
    // Default per-call timeout (QA 2026-10-30): without one, a silent
    // endpoint (accepts the connection, never replies) hung the turn
    // forever. Callers can override via opts.timeoutMs.
    const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : OVH_DEFAULT_TIMEOUT_MS;
    let signal = opts.signal;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const order = this.rotationOrder(opts.model);
    let lastError: Error | null = null;
    for (let i = 0; i < order.length; i++) {
      const model = order[i]!;
      this.lastCallByModel.set(model, this.now());
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
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
                  // NOTE: no parallel_tool_calls flag — the endpoint
                  // rejects the flag itself ("feature
                  // 'parallel_tool_calls=false' is not currently
                  // supported"). Its single-call constraint is handled by
                  // rotation on the matching 400 below.
                }
              : {}),
            ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
            ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
            stream: false,
          }),
          signal,
        });
      } catch (err) {
        // Network-level failure (unreachable, reset, timeout abort):
        // record and try the next rotation model; the last error surfaces
        // if every model fails this way.
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < order.length - 1) {
          try {
            opts.onRetry?.(i + 1, lastError);
          } catch {
            // Retry notification must never break rotation.
          }
          continue;
        }
        throw lastError;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // Rotate — don't fail the turn — when the failure is specific to
        // this model: 429 (per-model cap), 404 (model not served on the
        // anonymous lane), a 5xx from the model router, or the endpoint's
        // single-tool-call rejection (400 "This model only supports
        // single tool-calls at once!"): the model attempted parallel
        // tool calls, which this endpoint refuses to return — another
        // rotation model may well answer with a single call. Observed
        // live 2026-10-30 (universal-chat smoke: fusion workers on a
        // tool-carrying bot; every worker hit it on the first model).
        const singleCallRejection = res.status === 400 && text.includes('single tool-calls');
        const rotatable =
          res.status === 429 || res.status === 404 || res.status >= 500 || singleCallRejection;
        if (rotatable && i < order.length - 1) {
          if (res.status === 404) this.unavailableModels.add(model);
          lastError = new Error(
            res.status === 429
              ? `OVHcloud anonymous lane rate-limited model "${model}" (429); rotating to the next model.`
              : singleCallRejection
                ? `OVHcloud anonymous lane model "${model}" attempted parallel tool calls, which the endpoint rejects; rotating to the next model.`
                : `OVHcloud anonymous lane could not serve model "${model}" (${res.status}); rotating to the next model.`,
          );
          try {
            opts.onRetry?.(i + 1, lastError);
          } catch {
            // Retry notification must never break rotation.
          }
          continue;
        }
        if (res.status === 404) this.unavailableModels.add(model);
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
