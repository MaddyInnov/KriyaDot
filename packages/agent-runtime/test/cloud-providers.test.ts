// SPDX-License-Identifier: Apache-2.0
// Bedrock (SigV4 + Converse) and Vertex (service-account OAuth2)
// drivers. Zero paid API usage — fetch is stubbed throughout.

import { generateKeyPairSync, createVerify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BedrockProvider,
  buildConverseRequest,
  deriveSigningKey,
  parseConverseResponse,
  signBedrockRequest,
} from '../src/providers/bedrock.js';
import { VertexProvider, buildServiceAccountJwt } from '../src/providers/vertex.js';
import { createProvider } from '../src/providers/factory.js';
import { getProviderPreset } from '../src/providers/catalog.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('Bedrock SigV4', () => {
  it('derives a 32-byte signing key and produces a scoped Authorization header', () => {
    expect(deriveSigningKey('secret', '20250101', 'us-east-1', 'bedrock')).toHaveLength(32);
    const signed = signBedrockRequest({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      path: '/model/amazon.nova-pro-v1:0/converse',
      body: '{"messages":[]}',
      now: new Date('2025-01-02T03:04:05.000Z'),
    });
    expect(signed.url).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com/model/amazon.nova-pro-v1:0/converse',
    );
    expect(signed.headers.authorization).toContain(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20250102/eu-west-1/bedrock/aws4_request',
    );
    expect(signed.headers.authorization).toContain('SignedHeaders=content-type;host;x-amz-date');
    expect(signed.headers['x-amz-date']).toBe('20250102T030405Z');
  });

  it('includes the session token header when present', () => {
    const signed = signBedrockRequest({
      region: 'us-east-1',
      credentials: { accessKeyId: 'A', secretAccessKey: 'S', sessionToken: 'tok' },
      path: '/model/x/converse',
      body: '{}',
      now: new Date('2025-01-02T00:00:00.000Z'),
    });
    expect(signed.headers['x-amz-security-token']).toBe('tok');
    expect(signed.headers.authorization).toContain('x-amz-security-token');
  });
});

describe('Bedrock Converse mapping', () => {
  it('maps system/user/assistant/tool messages and tool specs', () => {
    const req = buildConverseRequest(
      [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'deploy please' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 't1', name: 'deploy', args: { env: 'prod' } }],
        },
        { role: 'tool', content: '{"deployed":true}', toolCallId: 't1', toolName: 'deploy' },
      ],
      [
        {
          name: 'deploy',
          description: 'Deploy.',
          parameters: { type: 'object', properties: { env: { type: 'string' } } },
          handler: async () => ({}),
        },
      ],
      {},
    );
    expect(req.system).toEqual([{ text: 'Be terse.' }]);
    const messages = req.messages as Array<{ role: string; content: unknown[] }>;
    expect(messages[0]).toEqual({ role: 'user', content: [{ text: 'deploy please' }] });
    expect(messages[1]!.content).toContainEqual({
      toolUse: { toolUseId: 't1', name: 'deploy', input: { env: 'prod' } },
    });
    expect(messages[2]!.content).toContainEqual({
      toolResult: { toolUseId: 't1', content: [{ json: { deployed: true } }], status: 'success' },
    });
    const toolConfig = req.toolConfig as { tools: Array<{ toolSpec: { name: string } }> };
    expect(toolConfig.tools[0]!.toolSpec.name).toBe('deploy');
  });

  it('marks errored tool results and parses responses', () => {
    const req = buildConverseRequest(
      [
        { role: 'user', content: 'go' },
        { role: 'tool', content: '{"error":"boom"}', toolCallId: 't9', toolName: 'x' },
      ],
      [],
      {},
    );
    const messages = req.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const allBlocks = messages.flatMap((m) => m.content);
    const toolResult = allBlocks.find((b) => 'toolResult' in b)!.toolResult as { status: string };
    expect(toolResult.status).toBe('error');

    const parsed = parseConverseResponse({
      output: {
        message: {
          content: [
            { text: 'Working on it. ' },
            { toolUse: { toolUseId: 't2', name: 'deploy', input: { env: 'staging' } } },
          ],
        },
      },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(parsed.content).toBe('Working on it. ');
    expect(parsed.toolCalls).toEqual([{ id: 't2', name: 'deploy', args: { env: 'staging' } }]);
    expect(parsed.usage.totalTokens).toBe(15);
  });

  it('chat() signs and posts to Converse; missing credentials throw clearly', async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {};
    const provider = new BedrockProvider({
      region: 'us-east-1',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      fetchFn: (async (url: string, init?: RequestInit) => {
        seen.url = url;
        seen.headers = init?.headers as Record<string, string>;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            output: { message: { content: [{ text: 'Hello from Bedrock' }] } },
            usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
          }),
          text: async () => '',
        } as Response;
      }) as typeof fetch,
    });
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'amazon.nova-pro-v1:0' });
    expect(res.content).toBe('Hello from Bedrock');
    expect(seen.url).toContain('/model/amazon.nova-pro-v1%3A0/converse');
    expect(seen.headers?.authorization).toContain('AWS4-HMAC-SHA256');

    const unconfigured = new BedrockProvider({ accessKeyId: '', secretAccessKey: '' });
    vi.stubEnv('AWS_ACCESS_KEY_ID', '');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', '');
    await expect(
      unconfigured.chat([{ role: 'user', content: 'hi' }], [], { model: 'x' }),
    ).rejects.toThrow('AWS_ACCESS_KEY_ID');
  });
});

describe('Vertex AI', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = {
    client_email: 'bot@demo-project.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };

  it('builds a verifiable RS256 service-account JWT', () => {
    const jwt = buildServiceAccountJwt(sa, 1_700_000_000);
    const [header, claims, signature] = jwt.split('.') as [string, string, string];
    const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as {
      iss: string;
      exp: number;
    };
    expect(decoded.iss).toBe(sa.client_email);
    expect(decoded.exp).toBe(1_700_000_000 + 3600);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${claims}`);
    expect(
      verifier.verify(
        publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('exchanges the JWT for a token and chats via the OpenAI-compatible endpoint', async () => {
    const tokenFetch = (async (url: string) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'ya29.test-token', expires_in: 3600 }),
        text: async () => '',
      } as Response;
    }) as typeof fetch;

    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"Hello from Vertex"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const chatHeaders: Record<string, string>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        expect(String(url)).toContain('aiplatform.googleapis.com');
        expect(String(url)).toContain('/projects/demo-project/');
        chatHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }),
    );

    const provider = new VertexProvider({
      project: 'demo-project',
      location: 'us-central1',
      serviceAccount: sa,
      fetchFn: tokenFetch,
    });
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], {
      model: 'google/gemini-2.5-flash',
    });
    expect(res.content).toBe('Hello from Vertex');
    expect(chatHeaders[0]!.Authorization).toBe('Bearer ya29.test-token');
  });
});

describe('cloud provider catalog + factory', () => {
  it('registers bedrock and vertex presets', () => {
    expect(getProviderPreset('bedrock')?.api).toBe('bedrock');
    expect(getProviderPreset('vertex')?.api).toBe('vertex');
  });

  it('createProvider constructs the cloud drivers', () => {
    expect(createProvider('bedrock')).toBeInstanceOf(BedrockProvider);
    expect(createProvider('vertex')).toBeInstanceOf(VertexProvider);
  });
});
