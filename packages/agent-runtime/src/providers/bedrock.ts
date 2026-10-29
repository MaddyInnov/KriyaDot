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
}

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
  if (opts.responseFormat) {
    // Converse has no response_format: enforce via a system contract
    // (the runtime additionally validates + retries, like Anthropic).
    const contract =
      opts.responseFormat.type === 'json_schema'
        ? `Respond with a single JSON object conforming to this JSON Schema: ${JSON.stringify(opts.responseFormat.schema)}. Output ONLY the JSON object — no prose, no code fences.`
        : 'Respond with a single valid JSON object. Output ONLY the JSON object — no prose, no code fences.';
    system.push({ text: contract });
  }
  const request: Record<string, unknown> = { messages: converse };
  if (system.length > 0) request.system = system;
  const inference: Record<string, number> = {};
  if (opts.temperature !== undefined) inference.temperature = opts.temperature;
  if (opts.topP !== undefined) inference.topP = opts.topP;
  if (opts.maxTokens !== undefined) inference.maxTokens = opts.maxTokens;
  if (Object.keys(inference).length > 0) request.inferenceConfig = inference;
  if (tools.length > 0) {
    request.toolConfig = {
      tools: tools.map((t) => ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.parameters },
        },
      })),
      toolChoice: { auto: {} },
    };
  }
  return request;
}

export function parseConverseResponse(data: Record<string, unknown>): {
  content: string;
  toolCalls: ToolCall[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
} {
  const output = data.output as { message?: { content?: ConverseBlock[] } } | undefined;
  const blocks = output?.message?.content ?? [];
  let content = '';
  const toolCalls: ToolCall[] = [];
  for (const block of blocks) {
    if ('text' in block && typeof block.text === 'string') content += block.text;
    if ('toolUse' in block) {
      toolCalls.push({
        id: block.toolUse.toolUseId,
        name: block.toolUse.name,
        args: block.toolUse.input ?? {},
      });
    }
  }
  const usage = (data.usage ?? {}) as { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  return {
    content,
    toolCalls,
    usage: {
      promptTokens: usage.inputTokens ?? 0,
      completionTokens: usage.outputTokens ?? 0,
      totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
    },
  };
}

export class BedrockProvider implements LLMProvider {
  readonly providerId = 'bedrock';
  private readonly region: string;
  private readonly credentials?: AwsCredentials;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;

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
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts: {
      model: string;
      signal?: AbortSignal;
      onToken?: (t: string) => void;
      temperature?: number;
      topP?: number;
      maxTokens?: number;
      responseFormat?: StructuredOutputSpec;
    },
  ): Promise<{
    content: string;
    toolCalls: ToolCall[];
    usage: { promptTokens: number; completionTokens: number; totalTokens: number };
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
    const signed = signBedrockRequest({
      region: this.region,
      credentials: this.credentials,
      path: modelPath,
      body,
      now: this.now(),
    });
    const res = await this.fetchFn(signed.url, {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
      signal: opts.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Bedrock Converse failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const parsed = parseConverseResponse(data);
    if (parsed.content && opts.onToken) opts.onToken(parsed.content);
    return parsed;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'anthropic.claude-3-5-sonnet-20241022-v2:0', name: 'Claude 3.5 Sonnet (Bedrock)' },
      { id: 'amazon.nova-pro-v1:0', name: 'Amazon Nova Pro' },
      { id: 'meta.llama3-3-70b-instruct-v1:0', name: 'Llama 3.3 70B (Bedrock)' },
    ];
  }
}
