// SPDX-License-Identifier: Apache-2.0
/**
 * AWS Bedrock driver (Octomind parity — broader direct providers).
 *
 * Bedrock is NOT OpenAI-compatible: it speaks the Converse API over
 * HTTPS with AWS Signature Version 4 request signing. This driver
 * implements SigV4 in pure TypeScript (node:crypto HMAC chain — no AWS
 * SDK dependency) and maps the platform's chat/tool shapes onto
 * Converse request/response blocks.
 *
 * Configuration (env): AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
 * (+ optional AWS_SESSION_TOKEN), region from AWS_REGION /
 * AWS_DEFAULT_REGION (default us-east-1). Calls are non-streaming
 * (Converse's binary event-stream is deliberately avoided); the full
 * completion is delivered through onToken once, like the CLI drivers.
 */

import { createHash, createHmac } from 'node:crypto';
import type {
  ChatMessage,
  LLMProvider,
  ModelInfo,
  StructuredOutputSpec,
  ToolCall,
  ToolDefinition,
} from '../types.js';
import { getMessageToolCalls } from '../types.js';

export interface BedrockOptions {
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  fetchFn?: typeof fetch;
  /** Clock override for signing tests. */
  now?: () => Date;
  /** Injectable backoff sleep (tests). */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Name of the forced tool used for native structured output (parity
 * #108). Converse has no `response_format`; the driver's native
 * mechanism is a forced tool call: when a call carries a
 * responseFormat spec, the driver adds this toolSpec (its inputSchema
 * IS the requested JSON Schema) and sets
 * `toolConfig.toolChoice = { tool: { name: '__structured_output' } }`.
 * The tool call's input is returned as the reply content (JSON), never
 * surfaced as a runtime tool call. A structured call is a final-answer
 * call: user tools are still declared, but the forced choice means the
 * model answers with the structured tool instead of calling them.
 */
export const BEDROCK_STRUCTURED_OUTPUT_TOOL_NAME = '__structured_output';

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** SigV4 signing key derivation (kDate → kRegion → kService → kSigning). */
export function deriveSigningKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Sign a Bedrock-runtime POST request (exported for tests). */
export function signBedrockRequest(opts: {
  region: string;
  credentials: AwsCredentials;
  path: string;
  body: string;
  now: Date;
}): SignedRequest {
  const host = `bedrock-runtime.${opts.region}.amazonaws.com`;
  const service = 'bedrock';
  const amzDate = opts.now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(opts.body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host,
    'x-amz-date': amzDate,
    ...(opts.credentials.sessionToken ? { 'x-amz-security-token': opts.credentials.sessionToken } : {}),
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]!.trim()}\n`).join('');
  const canonicalRequest = [
    'POST',
    opts.path,
    '',
    canonicalHeaders,
    signedHeaderNames.join(';'),
    payloadHash,
  ].join('\n');
  const scope = `${dateStamp}/${opts.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = deriveSigningKey(opts.credentials.secretAccessKey, dateStamp, opts.region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`;
  return { url: `https://${host}${opts.path}`, headers, body: opts.body };
}

// ---- Converse mapping ------------------------------------------------------

type ConverseBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { toolResult: { toolUseId: string; content: Array<{ json: unknown } | { text: string }>; status: 'success' | 'error' } };

interface ConverseMessage {
  role: 'user' | 'assistant';
  content: ConverseBlock[];
}

/** Shape guard for #34 replay: a raw Converse content block. */
function isConverseBlock(v: unknown): v is ConverseBlock {
  if (typeof v !== 'object' || v === null) return false;
  const b = v as Record<string, unknown>;
  if (typeof b.text === 'string') return true;
  if (typeof b.toolUse === 'object' && b.toolUse !== null) return true;
  if (typeof b.toolResult === 'object' && b.toolResult !== null) return true;
  return false;
}

export function buildConverseRequest(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  opts: { temperature?: number; topP?: number; maxTokens?: number; responseFormat?: StructuredOutputSpec },
): Record<string, unknown> {
  const system: Array<{ text: string }> = [];
  const converse: ConverseMessage[] = [];
  const push = (role: 'user' | 'assistant', block: ConverseBlock): void => {
    const last = converse[converse.length - 1];
    if (last && last.role === role) last.content.push(block);
    else converse.push({ role, content: [block] });
  };
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'system') {
      if (text) system.push({ text });
    } else if (m.role === 'user') {
      if (text) push('user', { text });
    } else if (m.role === 'assistant') {
      // #34 replay: when this stored assistant message carries THIS
      // driver's native items (Converse content blocks, captured by
      // parseConverseResponse), replay them verbatim instead of
      // reconstructing blocks from flattened text/tool calls — the
      // reconstruction loses provider-side structure. Foreign-shaped
      // native items (another provider's) are ignored, never crossed.
      const native = (m as ChatMessage & { nativeItems?: unknown[] }).nativeItems;
      if (Array.isArray(native) && native.length > 0 && native.every(isConverseBlock)) {
        for (const block of native) push('assistant', block);
        continue;
      }
      if (text) push('assistant', { text });
      for (const call of getMessageToolCalls(m) ?? []) {
        push('assistant', {
          toolUse: { toolUseId: call.id, name: call.name, input: (call.args ?? {}) as Record<string, unknown> },
        });
      }
    } else if (m.role === 'tool') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const isError =
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof (parsed as { error?: unknown }).error === 'string';
      push('user', {
        toolResult: {
          toolUseId: m.toolCallId ?? '',
          content: [parsed !== undefined ? { json: parsed } : { text }],
          status: isError ? 'error' : 'success',
        },
      });
    }
  }
  // Converse requires the first message to be a user message.
  if (converse.length > 0 && converse[0]!.role === 'assistant') {
    converse.unshift({ role: 'user', content: [{ text: '(continued)' }] });
  }
  const request: Record<string, unknown> = { messages: converse };
  if (system.length > 0) request.system = system;
  const inference: Record<string, number> = {};
  if (opts.temperature !== undefined) inference.temperature = opts.temperature;
  if (opts.topP !== undefined) inference.topP = opts.topP;
  if (opts.maxTokens !== undefined) inference.maxTokens = opts.maxTokens;
  if (Object.keys(inference).length > 0) request.inferenceConfig = inference;
  const toolSpecs: Array<Record<string, unknown>> = tools.map((t) => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: { json: t.parameters },
    },
  }));
  if (opts.responseFormat) {
    // Native structured output via a forced tool call (see
    // BEDROCK_STRUCTURED_OUTPUT_TOOL_NAME above) — no prompt-append
    // contract on this driver anymore.
    toolSpecs.push({
      toolSpec: {
        name: BEDROCK_STRUCTURED_OUTPUT_TOOL_NAME,
        description:
          'Return the final answer as structured data conforming to the input schema. ' +
          'Call this tool exactly once with the complete answer as its input.',
        inputSchema: {
          json:
            opts.responseFormat.type === 'json_schema'
              ? opts.responseFormat.schema
              : { type: 'object', additionalProperties: true },
        },
      },
    });
  }
  if (toolSpecs.length > 0) {
    request.toolConfig = {
      tools: toolSpecs,
      toolChoice: opts.responseFormat
        ? { tool: { name: BEDROCK_STRUCTURED_OUTPUT_TOOL_NAME } }
        : { auto: {} },
    };
  }
  return request;
}

export function parseConverseResponse(
  data: Record<string, unknown>,
  opts: { structured?: boolean } = {},
): {
  content: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  /** #34 capture: the raw Converse content blocks, verbatim. */
  nativeItems: unknown[];
} {
  const output = data.output as { message?: { content?: ConverseBlock[] } } | undefined;
  const blocks = output?.message?.content ?? [];
  let content = '';
  const toolCalls: ToolCall[] = [];
  for (const block of blocks) {
    if ('text' in block && typeof block.text === 'string') content += block.text;
    if ('toolUse' in block) {
      if (opts.structured && block.toolUse.name === BEDROCK_STRUCTURED_OUTPUT_TOOL_NAME) {
        // Native structured output: the forced tool's input IS the reply.
        content += JSON.stringify(block.toolUse.input ?? {});
      } else {
        toolCalls.push({
          id: block.toolUse.toolUseId,
          name: block.toolUse.name,
          args: block.toolUse.input ?? {},
        });
      }
    }
  }
  const usage = (data.usage ?? {}) as { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  return {
    content,
    toolCalls,
    // #34 capture: raw Converse blocks ride back verbatim so the
    // runtime can persist them as the assistant message's nativeItems
    // and buildConverseRequest can replay them on resume.
    nativeItems: blocks as unknown[],
    usage: {
      promptTokens: usage.inputTokens ?? 0,
      completionTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    },
  };
}

const BEDROCK_MAX_RETRIES_DEFAULT = 3;
const BEDROCK_BASE_BACKOFF_MS = 500;

function bedrockSleepDefault(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBedrockRetryable(status: number, bodyText: string): boolean {
  // Throttling (429 / ThrottlingException) and 5xx are retryable;
  // Bedrock occasionally reports throttling as a 400 validation-style
  // error whose body names ThrottlingException — honor that too.
  return status === 429 || status >= 500 || /ThrottlingException/i.test(bodyText);
}

export class BedrockProvider implements LLMProvider {
  readonly providerId = 'bedrock';
  private readonly region: string;
  private readonly credentials?: AwsCredentials;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(opts: BedrockOptions = {}) {
    this.region =
      opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
    const accessKeyId = opts.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = opts.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY;
    this.credentials =
      accessKeyId && secretAccessKey
        ? {
            accessKeyId,
            secretAccessKey,
            sessionToken: opts.sessionToken ?? process.env.AWS_SESSION_TOKEN,
          }
        : undefined;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? (() => new Date());
    this.sleepFn = opts.sleepFn ?? bedrockSleepDefault;
  }

  /**
   * Chat via Converse with per-profile retry/timeout controls (parity
   * #11): `opts.maxRetries` (default 3) retries throttling/5xx and
   * network errors with exponential backoff; `opts.timeoutMs` bounds
   * the whole call via an AbortSignal combined with the caller's
   * signal. Each attempt is re-signed (SigV4 timestamps go stale).
   * Aborts are never retried.
   */
  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: Parameters<LLMProvider['chat']>[2],
  ): Promise<{
    content: string;
    toolCalls: ToolCall[];
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    /** #34: raw Converse blocks captured for session persistence/replay. */
    nativeItems: unknown[];
  }> {
    if (!this.credentials) {
      throw new Error(
        'AWS Bedrock is not configured: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_REGION if not us-east-1).',
      );
    }
    const body = JSON.stringify(
      buildConverseRequest(messages, tools, {
        temperature: opts.temperature,
        topP: opts.topP,
        maxTokens: opts.maxTokens,
        responseFormat: opts.responseFormat,
      }),
    );
    const modelPath = `/model/${encodeURIComponent(opts.model)}/converse`;
    let signal = opts.signal;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      const timeoutSignal = AbortSignal.timeout(opts.timeoutMs);
      signal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    }
    const maxRetries = Math.max(0, Math.floor(opts.maxRetries ?? BEDROCK_MAX_RETRIES_DEFAULT));
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const signed = signBedrockRequest({
        region: this.region,
        credentials: this.credentials,
        path: modelPath,
        body,
        now: this.now(),
      });
      let res: Response;
      try {
        res = await this.fetchFn(signed.url, {
          method: 'POST',
          headers: signed.headers,
          body: signed.body,
          signal,
        });
      } catch (err) {
        if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
        if (attempt >= maxRetries) throw err;
        const lastError = err instanceof Error ? err : new Error(String(err));
        try {
          opts.onRetry?.(attempt + 1, lastError);
        } catch {
          // Retry notification must never break the retry loop.
        }
        await this.sleepFn(BEDROCK_BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Bedrock Converse failed (${res.status}): ${text.slice(0, 300)}`);
        if (!isBedrockRetryable(res.status, text) || attempt >= maxRetries) throw err;
        try {
          opts.onRetry?.(attempt + 1, err);
        } catch {
          // Retry notification must never break the retry loop.
        }
        await this.sleepFn(BEDROCK_BASE_BACKOFF_MS * 2 ** attempt);
        continue;
      }
      const data = (await res.json()) as Record<string, unknown>;
      const parsed = parseConverseResponse(data, { structured: Boolean(opts.responseFormat) });
      if (parsed.content && opts.onToken) opts.onToken(parsed.content);
      return parsed;
    }
    throw new Error('Bedrock Converse failed after retries');
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet (Bedrock)' },
      { id: 'amazon.nova-pro-v1:0', name: 'Amazon Nova Pro' },
      { id: 'meta.llama3-3-70b-instruct-v1:0', name: 'Llama 3.3 70B (Bedrock)' },
    ];
  }
}
