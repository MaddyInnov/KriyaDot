// SPDX-License-Identifier: Apache-2.0
/**
 * Cohere driver (Octomind parity #4 — provider-specific drivers).
 *
 * Cohere's native Chat API (v2, https://api.cohere.com/v2/chat) is NOT
 * OpenAI-shaped: messages carry typed content parts, assistant tool
 * calls ride as `tool-call` content parts with stringified arguments,
 * outbound tools use the `{type:'function', function:{...}}` envelope,
 * and usage comes back as `usage.tokens.{input,output}_tokens`. A shared
 * OpenAI-compatible preset against the native endpoint would be
 * materially wrong, so Cohere gets this dedicated driver. (Cohere also
 * publishes an OpenAI-compatibility endpoint; the native v2 API is the
 * fuller surface — tools + response_format — so the catalog preset
 * points here.)
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

export interface CohereOptions {
  baseUrl?: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

type CohereContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; function: { name: string; arguments: string } };

interface CohereMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | CohereContentPart[];
  tool_call_id?: string;
}

function toCohereMessages(messages: ChatMessage[]): CohereMessage[] {
  const out: CohereMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' });
    } else if (m.role === 'assistant') {
      // #34 replay: a stored assistant message carrying THIS driver's
      // native items (the raw Cohere message object captured at reply
      // time) is re-emitted verbatim rather than reconstructed from
      // flattened text/tool calls. Foreign shapes are ignored.
      const native = (m as ChatMessage & { nativeItems?: unknown[] }).nativeItems;
      const nativeMsg = Array.isArray(native) ? (native[0] as { content?: unknown; tool_calls?: unknown } | undefined) : undefined;
      if (nativeMsg && Array.isArray(nativeMsg.content)) {
        const parts: CohereContentPart[] = [];
        for (const p of nativeMsg.content as Array<Record<string, unknown>>) {
          if (p.type === 'text' && typeof p.text === 'string') parts.push({ type: 'text', text: p.text });
          else if (p.type === 'tool-call' && typeof p.id === 'string') {
            const fn = p.function as { name?: string; arguments?: string } | undefined;
            parts.push({ type: 'tool-call', id: p.id, function: { name: fn?.name ?? '', arguments: fn?.arguments ?? '{}' } });
          }
        }
        // tool_calls captured outside content parts (wire variant).
        if (Array.isArray(nativeMsg.tool_calls)) {
          for (const tc of nativeMsg.tool_calls as Array<{ id?: string; function?: { name?: string; arguments?: string } }>) {
            if (tc.function?.name) {
              parts.push({ type: 'tool-call', id: tc.id ?? `call_${parts.length}`, function: { name: tc.function.name, arguments: tc.function.arguments ?? '{}' } });
            }
          }
        }
        if (parts.length > 0) {
          out.push({ role: 'assistant', content: parts });
          continue;
        }
      }
      const calls = getMessageToolCalls(m) ?? [];
      if (calls.length === 0) {
        out.push({ role: 'assistant', content: m.content });
      } else {
        const parts: CohereContentPart[] = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        for (const tc of calls) {
          parts.push({
            type: 'tool-call',
            id: tc.id,
            function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
          });
        }
        out.push({ role: 'assistant', content: parts });
      }
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export class CohereProvider implements LLMProvider {
  readonly providerId = 'cohere';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: CohereOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://api.cohere.com/v2').replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchFn =
      opts.fetchFn ?? (((...args: Parameters<typeof fetch>) => fetch(...args)) as typeof fetch);
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: Parameters<LLMProvider['chat']>[2],
  ): Promise<{ content: string; toolCalls: ToolCall[]; usage: TokenUsage; nativeItems: unknown[] }> {
    let signal = opts.signal;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
      signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    }
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: toCohereMessages(messages),
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
      ...(opts.responseFormat
        ? {
            response_format:
              opts.responseFormat.type === 'json_object'
                ? { type: 'json_object' }
                : { type: 'json_schema', json_schema: opts.responseFormat.schema },
          }
        : {}),
    };
    const res = await this.fetchFn(`${this.baseUrl}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(
        `Cohere request failed: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 300)}` : ''}`,
      ) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    const data = (await res.json()) as {
      message?: {
        content?: Array<{ type?: string; text?: string }>;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      };
      usage?: { tokens?: { input_tokens?: number; output_tokens?: number } };
    };
    const textParts: string[] = [];
    for (const part of data.message?.content ?? []) {
      if (part.type === 'text' && typeof part.text === 'string') {
        textParts.push(part.text);
        opts.onToken?.(part.text);
      }
    }
    const toolCalls: ToolCall[] = [];
    for (const tc of data.message?.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        args = tc.function?.arguments
          ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
          : {};
      } catch {
        args = { _raw: tc.function?.arguments ?? '' };
      }
      if (tc.function?.name) {
        toolCalls.push({ id: tc.id ?? `call_${toolCalls.length}`, name: tc.function.name, args });
      }
    }
    const input = data.usage?.tokens?.input_tokens ?? 0;
    const output = data.usage?.tokens?.output_tokens ?? 0;
    return {
      content: textParts.join(''),
      toolCalls,
      // #34 capture: the raw Cohere message object, verbatim — the
      // runtime persists it as the assistant message's nativeItems
      // and toCohereMessages replays it on resume.
      nativeItems: data.message ? [data.message as unknown] : [],
      usage: { promptTokens: input, completionTokens: output, totalTokens: input + output },
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    const { getProviderPreset } = await import('./catalog.js');
    const preset = getProviderPreset('cohere');
    return (preset?.models ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.contextLength,
    }));
  }
}
