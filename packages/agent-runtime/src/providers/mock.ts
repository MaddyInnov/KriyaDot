// SPDX-License-Identifier: Apache-2.0

import type {
  ChatMessage,
  LLMProvider,
  ModelInfo,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '../types.js';

export interface MockStep {
  content?: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  /**
   * Provider-native output items (#34): returned verbatim on the chat
   * result so tests can exercise the capture → persist → replay path
   * exactly as a real driver behaves.
   */
  nativeItems?: unknown[];
}

const DEFAULT_USAGE: TokenUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

/**
 * Scripted provider for tests. Each chat() call consumes the next step
 * (the last step repeats), streaming content word-by-word through onToken.
 */
export class MockProvider implements LLMProvider {
  readonly providerId = 'mock';
  private readonly steps: MockStep[];
  private readonly tokenDelayMs: number;
  private cursor = 0;
  /** Every chat() invocation, in order — handy for assertions. */
  readonly calls: Array<{ messages: ChatMessage[]; model: string }> = [];

  constructor(steps: MockStep[], opts?: { tokenDelayMs?: number }) {
    if (steps.length === 0) throw new Error('MockProvider needs at least one scripted step');
    this.steps = steps;
    // Optional per-token pacing so demo/screenshot runs stream at a
    // human-visible rate like a real provider. Default 0 = instant
    // (every existing test keeps the synchronous behavior).
    this.tokenDelayMs = opts?.tokenDelayMs ?? 0;
  }

  async chat(
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    opts: { model: string; onToken?: (t: string) => void; signal?: AbortSignal },
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: TokenUsage; nativeItems: unknown[] }> {
    this.calls.push({ messages, model: opts.model });
    const step = this.steps[Math.min(this.cursor, this.steps.length - 1)];
    this.cursor += 1;
    const content = step.content ?? '';
    if (opts.onToken && content) {
      for (const word of content.split(/(\s+)/)) {
        if (word) opts.onToken(word);
        if (word && this.tokenDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.tokenDelayMs));
        }
      }
    }
    return {
      content,
      toolCalls: step.toolCalls ?? [],
      usage: step.usage ?? { ...DEFAULT_USAGE },
      // #34: captured native items ride the result verbatim; incoming
      // messages (with any stored nativeItems) are recorded in
      // `calls` untouched — the replay half of the round-trip.
      nativeItems: step.nativeItems ?? [],
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'mock-model', name: 'Mock Model' }];
  }
}

/** Convenience: build a scripted turn of [tool call…] then a final answer. */
export function scriptedBotTurn(toolCalls: ToolCall[], finalContent: string): MockStep[] {
  return [{ toolCalls }, { content: finalContent }];
}
