// SPDX-License-Identifier: Apache-2.0
/**
 * AI Horde driver (free-LLM stack #3 — deep fallback, plain chat only).
 *
 * AI Horde (https://aihorde.net/api/v2) is a volunteer-run inference
 * network with an officially sanctioned anonymous mode: the API key is
 * literally `0000000000` (lowest queue priority, restrictable under
 * load). Its API is an async job API — submit → poll — NOT
 * OpenAI-shaped, and it has no tool/function calling.
 *
 * Hard rules implemented here:
 *  - tool-calling requests are REJECTED with a clear error (the runtime
 *    must route tool-using turns to another lane instead);
 *  - structured-output requests are likewise rejected;
 *  - anonymous calls cap max_tokens at 512 (the project's own client
 *    cap for anonymous users).
 */

import type {
  ChatMessage,
  LLMProvider,
  ModelInfo,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '../types.js';

export const AIHORDE_BASE_URL = 'https://aihorde.net/api/v2';
/** The project's official anonymous API key. */
export const AIHORDE_ANONYMOUS_KEY = '0000000000';
/** Anonymous response cap enforced by AI Horde clients. */
export const AIHORDE_ANONYMOUS_MAX_TOKENS = 512;
/** Default per-HTTP-request timeout for submit/status calls. */
export const AIHORDE_REQUEST_TIMEOUT_MS = 30_000;

export interface AiHordeOptions {
  baseUrl?: string;
  /** User's own Horde key; defaults to the official anonymous key. */
  apiKey?: string;
  fetchFn?: typeof fetch;
  /** Poll interval in ms (tests inject 0/tiny). Default 3000. */
  pollIntervalMs?: number;
  /** Max status polls before giving up. Default 100. */
  maxPolls?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Flatten chat messages into a single completion-style prompt. */
export function buildHordePrompt(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') lines.push(`System: ${m.content}`);
    else if (m.role === 'user') lines.push(`User: ${m.content}`);
    else if (m.role === 'assistant') lines.push(`Assistant: ${m.content}`);
    else if (m.role === 'tool') lines.push(`Tool result: ${m.content}`);
  }
  lines.push('Assistant:');
  return lines.join('\n');
}

export class AiHordeProvider implements LLMProvider {
  readonly providerId = 'aihorde';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly anonymous: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(opts: AiHordeOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? AIHORDE_BASE_URL).replace(/\/+$/, '');
    this.apiKey = opts.apiKey && opts.apiKey.length > 0 ? opts.apiKey : AIHORDE_ANONYMOUS_KEY;
    this.anonymous = this.apiKey === AIHORDE_ANONYMOUS_KEY;
    this.fetchFn =
      opts.fetchFn ?? (((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch);
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.maxPolls = opts.maxPolls ?? 100;
    this.sleepFn = opts.sleepFn ?? sleep;
  }

  /** Effective output-token cap for a request (512 for anonymous). */
  effectiveMaxTokens(requested?: number): number {
    const want = requested ?? AIHORDE_ANONYMOUS_MAX_TOKENS;
    return this.anonymous ? Math.min(want, AIHORDE_ANONYMOUS_MAX_TOKENS) : want;
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: Parameters<LLMProvider['chat']>[2],
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: TokenUsage }> {
    if (tools.length > 0) {
      throw new Error(
        'AI Horde does not support tool calls — plain chat only. ' +
          'Route tool-using turns to another provider in the keyless chain (Ollama / OVHcloud / LLM7).',
      );
    }
    if (opts.responseFormat) {
      throw new Error(
        'AI Horde does not support structured output — plain chat only. ' +
          'Route structured-output turns to another provider in the keyless chain.',
      );
    }
    const maxTokens = this.effectiveMaxTokens(opts.maxTokens);
    // Per-request timeout (QA 2026-10-30): the poll loop is bounded by
    // maxPolls, but a single fetch against a silent endpoint never
    // returns, so the bound never advances. Bound every HTTP call;
    // opts.timeoutMs (when set) is the per-request budget.
    const requestTimeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : AIHORDE_REQUEST_TIMEOUT_MS;
    const requestSignal = (): AbortSignal => {
      const t = AbortSignal.timeout(requestTimeoutMs);
      return opts.signal ? AbortSignal.any([opts.signal, t]) : t;
    };
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      apikey: this.apiKey,
      'Client-Agent': 'kriyadot:1.0:agent-runtime',
    };
    const submit = await this.fetchFn(`${this.baseUrl}/generate/text/async`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        prompt: buildHordePrompt(messages),
        params: {
          max_length: maxTokens,
          max_context_length: 2048,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        },
        // The catalog default id is a lane name, not a worker model.
        ...(opts.model && opts.model !== 'koboldcpp' ? { models: [opts.model] } : {}),
        slow_workers: true,
      }),
      signal: requestSignal(),
    });
    if (!submit.ok) {
      const text = await submit.text().catch(() => '');
      throw new Error(`AI Horde submit failed: ${submit.status}${text ? ` — ${text.slice(0, 300)}` : ''}`);
    }
    const submitted = (await submit.json()) as { id?: string };
    if (!submitted.id) throw new Error('AI Horde submit returned no job id.');

    for (let poll = 0; poll < this.maxPolls; poll++) {
      if (poll > 0) await this.sleepFn(this.pollIntervalMs);
      const res = await this.fetchFn(`${this.baseUrl}/generate/text/status/${submitted.id}`, {
        headers,
        signal: requestSignal(),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`AI Horde status failed: ${res.status}${text ? ` — ${text.slice(0, 300)}` : ''}`);
      }
      const status = (await res.json()) as {
        done?: boolean;
        faulted?: boolean;
        generations?: Array<{ text?: string }>;
      };
      if (status.faulted) throw new Error('AI Horde job faulted on the worker network.');
      if (status.done) {
        const content = status.generations?.[0]?.text ?? '';
        if (content) opts.onToken?.(content);
        // The Horde does not report per-job token usage; zeros are
        // honest (no usage data), not an estimate.
        return {
          content,
          toolCalls: [],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        };
      }
    }
    throw new Error(`AI Horde job ${submitted.id} did not finish after ${this.maxPolls} polls.`);
  }

  async listModels(): Promise<ModelInfo[]> {
    // Worker availability is dynamic; the lane exposes one logical model.
    return [{ id: 'koboldcpp', name: 'AI Horde (community workers)', free: true }];
  }
}
