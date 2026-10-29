// SPDX-License-Identifier: Apache-2.0
//
// LM Studio provider (ENGINES pack) — fully local models via LM Studio's
// OpenAI-compatible server (default http://localhost:1234/v1). No API
// key, ever; LM Studio ignores auth unless the user enabled it in the
// app's server settings. Model listing is LIVE: whatever models are
// loaded/downloaded in LM Studio appear via GET /v1/models.

import type { ChatMessage, ModelInfo, ToolCall, ToolDefinition, TokenUsage } from '../types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

/** LM Studio base URL: LMSTUDIO_BASE_URL env, default http://localhost:1234/v1. */
export function lmStudioBaseUrl(): string {
  const raw = (process.env.LMSTUDIO_BASE_URL ?? '').trim();
  return (raw.length > 0 ? raw : 'http://localhost:1234/v1').replace(/\/+$/, '');
}

interface LmStudioModelEntry {
  id: string;
}

/**
 * Driver for a local LM Studio server. Chat + model listing both go
 * through its OpenAI-compatible endpoints. Honors the local reply
 * timeout (constructor default, overridable per call via
 * opts.replyTimeoutMs / opts.timeoutMs — see openai-compatible.ts).
 */
export class LmStudioProvider extends OpenAICompatibleProvider {
  private readonly replyTimeoutMs?: number;

  constructor(opts: { replyTimeoutMs?: number; baseUrl?: string } = {}) {
    super({
      providerId: 'lmstudio',
      baseUrl: opts.baseUrl ?? lmStudioBaseUrl(),
      // Local server ignores Authorization by default; never a real secret.
      apiKey: 'lmstudio-no-key-needed',
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
          `LM Studio is not reachable at ${lmStudioBaseUrl()}. Start LM Studio, load a model, ` +
            `and start its local server (default port 1234). Set LMSTUDIO_BASE_URL if it runs elsewhere.`,
        );
      }
      throw err;
    }
  }

  override async listModels(): Promise<ModelInfo[]> {
    const base = lmStudioBaseUrl();
    let res: Response;
    try {
      res = await fetch(`${base}/models`);
    } catch {
      // LM Studio not running: no models to list (catalog fallback applies).
      return [];
    }
    if (!res.ok) return [];
    const data = (await res.json().catch(() => null)) as { data?: LmStudioModelEntry[] } | null;
    if (!data || !Array.isArray(data.data)) return [];
    return data.data.map((m) => ({
      id: m.id,
      name: m.id,
      // Local models are always "free" — no per-token cost.
      free: true,
    }));
  }
}
