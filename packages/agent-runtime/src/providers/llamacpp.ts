// SPDX-License-Identifier: Apache-2.0
//
// Managed local LLM provider (Atomic Agent parity) — chat against the
// zero-config llama.cpp server managed by LocalLlmManager (see
// ../local-llm.ts). No API key, ever; the server binds 127.0.0.1 only.

import type { ChatMessage, ModelInfo, ToolCall, ToolDefinition, TokenUsage } from '../types.js';
import { llamacppBaseUrl, llamacppPort } from '../local-llm.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

interface LlamaCppModelEntry {
  id: string;
}

/**
 * Driver for the managed llama.cpp server. Chat goes through llama-server's
 * OpenAI-compatible /v1/chat/completions; model listing uses /v1/models.
 */
export class LlamaCppProvider extends OpenAICompatibleProvider {
  private readonly replyTimeoutMs?: number;

  constructor(opts: { replyTimeoutMs?: number } = {}) {
    super({
      providerId: 'llamacpp',
      baseUrl: `${llamacppBaseUrl()}/v1`,
      // Local server ignores Authorization entirely; the base class requires
      // a string. Never a real secret.
      apiKey: 'local-no-key-needed',
    });
    this.replyTimeoutMs = opts.replyTimeoutMs;
  }

  override async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: { model: string; onToken?: (t: string) => void; signal?: AbortSignal; timeoutMs?: number; replyTimeoutMs?: number },
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: TokenUsage }> {
    const effectiveOpts =
      opts.timeoutMs === undefined && opts.replyTimeoutMs === undefined && this.replyTimeoutMs !== undefined
        ? { ...opts, replyTimeoutMs: this.replyTimeoutMs }
        : opts;
    try {
      return await super.chat(messages, tools, effectiveOpts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(msg)) {
        throw new Error(
          `The managed local LLM server is not running on port ${llamacppPort()}. ` +
            `Open Settings → Local LLM, download the llama.cpp binary and a model, then press Start.`,
        );
      }
      throw err;
    }
  }

  override async listModels(): Promise<ModelInfo[]> {
    const base = llamacppBaseUrl();
    let res: Response;
    try {
      res = await fetch(`${base}/v1/models`);
    } catch {
      // Server not running: no models to list. listProviders() falls back
      // to the (empty) catalog list and warns.
      return [];
    }
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as { data?: LlamaCppModelEntry[] } | null;
    if (!data || !Array.isArray(data.data)) return [];
    return data.data.map((m) => ({
      id: m.id,
      name: m.id,
      // Local models are always "free" — no per-token cost.
      free: true,
    }));
  }
}
