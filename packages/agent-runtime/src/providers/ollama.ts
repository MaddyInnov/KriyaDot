// SPDX-License-Identifier: Apache-2.0
//
// Ollama provider — fully local models, no API key, ever (Octop parity).
// Talks to Ollama's OpenAI-compatible endpoint for chat and to /api/tags
// for the model list.

import type { ChatMessage, ModelInfo, ToolCall, ToolDefinition, TokenUsage } from '../types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

/** Ollama host: OLLAMA_HOST env, default http://localhost:11434. */
export function ollamaHost(): string {
  const raw = (process.env.OLLAMA_HOST ?? '').trim();
  return (raw.length > 0 ? raw : 'http://localhost:11434').replace(/\/+$/, '');
}

interface OllamaTag {
  name: string;
  model: string;
  details?: { parameter_size?: string; family?: string };
}

/**
 * Driver for local Ollama. Chat goes through the OpenAI-compatible
 * /v1/chat/completions (Ollama ignores auth headers); model listing uses
 * Ollama's native /api/tags.
 */
export class OllamaProvider extends OpenAICompatibleProvider {
  private readonly replyTimeoutMs?: number;

  constructor(opts: { replyTimeoutMs?: number } = {}) {
    super({
      providerId: 'ollama',
      baseUrl: `${ollamaHost()}/v1`,
      // Ollama ignores Authorization entirely; the base class requires a
      // string. Never a real secret.
      apiKey: 'ollama-no-key-needed',
    });
    this.replyTimeoutMs = opts.replyTimeoutMs;
  }

  override async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: { model: string; onToken?: (t: string) => void; signal?: AbortSignal; timeoutMs?: number; replyTimeoutMs?: number },
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: TokenUsage }> {
    // Local reply timeout (ENGINES pack): the provider-level default
    // applies when the call carries neither an explicit timeout nor a
    // per-bot replyTimeoutMs.
    const effectiveOpts =
      opts.timeoutMs === undefined && opts.replyTimeoutMs === undefined && this.replyTimeoutMs !== undefined
        ? { ...opts, replyTimeoutMs: this.replyTimeoutMs }
        : opts;
    try {
      return await super.chat(messages, tools, effectiveOpts);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const host = ollamaHost();
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(msg)) {
        throw new Error(
          `Ollama is not reachable at ${host}. Start Ollama (https://ollama.com/download) ` +
            `and pull a model, e.g. "ollama pull llama3.1". Set OLLAMA_HOST if it runs elsewhere.`,
        );
      }
      if (/does not support tools|tools are not supported/i.test(msg)) {
        throw new Error(
          `Model "${opts.model}" does not support tool calling. ` +
            `Use a tool-capable model (e.g. "ollama pull qwen2.5" or llama3.1) or ask without tools.`,
        );
      }
      throw err;
    }
  }

  override async listModels(): Promise<ModelInfo[]> {
    const host = ollamaHost();
    let res: Response;
    try {
      res = await fetch(`${host}/api/tags`);
    } catch {
      // Ollama not running: no models to list. listProviders() falls back
      // to the (empty) catalog list and warns.
      return [];
    }
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as { models?: OllamaTag[] } | null;
    if (!data || !Array.isArray(data.models)) return [];
    return data.models.map((m) => ({
      id: m.name,
      name: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name,
      // Local models are always "free" — no per-token cost.
      free: true,
    }));
  }
}
