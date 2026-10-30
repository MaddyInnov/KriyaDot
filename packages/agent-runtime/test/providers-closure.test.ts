// SPDX-License-Identifier: Apache-2.0
// Octomind closure workstream: provider breadth (#4), Anthropic/Bedrock
// retry+timeout (#11), native structured output (#108), .env chain (#12),
// and the keyless free-LLM stack. All fetch is injected/stubbed — no
// network, no paid APIs.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getProviderPreset,
  listProviderPresets,
  parseDotEnv,
  resolveApiKey,
} from '../src/providers/catalog.js';
import { createProvider } from '../src/providers/factory.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { AnthropicProvider, STRUCTURED_OUTPUT_TOOL_NAME } from '../src/providers/anthropic.js';
import {
  BedrockProvider,
  buildConverseRequest,
  parseConverseResponse,
} from '../src/providers/bedrock.js';
import { CohereProvider } from '../src/providers/cohere.js';
import { OvAnonymousProvider } from '../src/providers/ovh-anonymous.js';
import { AiHordeProvider } from '../src/providers/aihorde.js';
import {
  KEYLESS_FALLBACK_CHAIN,
  keylessChain,
  keylessProviderOrder,
} from '../src/providers/keyless-stack.js';

const ENV_KEYS = [
  'GROQ_API_KEY',
  'POLLINATIONS_API_KEY',
  'COHERE_API_KEY',
  'LLM7_API_KEY',
  'OVH_API_KEY',
  'AIHORDE_API_KEY',
  'PROVIDERS_FILE',
  'KRIYADOT_CONFIG_ENV_FILE',
  'KRIYADOT_PROJECT_ENV_FILE',
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.PROVIDERS_FILE = join(tmpdir(), 'closure-test-no-such-providers.json');
  process.env.KRIYADOT_CONFIG_ENV_FILE = join(tmpdir(), 'closure-test-no-such-config.env');
  process.env.KRIYADOT_PROJECT_ENV_FILE = join(tmpdir(), 'closure-test-no-such-project.env');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    headers: new Headers(),
    json: async () => payload,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  } as Response;
}

describe('catalog breadth (#4)', () => {
  it('has at least 30 presets with unique ids', () => {
    const presets = listProviderPresets();
    expect(presets.length).toBeGreaterThanOrEqual(30);
    const ids = presets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every preset is well-formed: URL, env key name, model ids', () => {
    for (const p of listProviderPresets()) {
      expect(p.envKey, p.id).toMatch(/^[A-Z][A-Z0-9_]*$/);
      if (p.baseUrl) {
        const url = new URL(p.baseUrl);
        if (p.local) expect(['http:', 'https:']).toContain(url.protocol);
        else expect(url.protocol, p.id).toBe('https:');
      }
      const modelIds = p.models.map((m) => m.id);
      expect(new Set(modelIds).size, p.id).toBe(modelIds.length);
      expect(p.models.filter((m) => m.default).length, p.id).toBeLessThanOrEqual(1);
    }
  });

  const NEW = [
    { id: 'perplexity', baseUrl: 'https://api.perplexity.ai', envKey: 'PERPLEXITY_API_KEY' },
    { id: 'cohere', baseUrl: 'https://api.cohere.com/v2', envKey: 'COHERE_API_KEY' },
    { id: 'ai21', baseUrl: 'https://api.ai21.com/studio/v1', envKey: 'AI21_API_KEY' },
    { id: 'nebius', baseUrl: 'https://api.studio.nebius.com/v1', envKey: 'NEBIUS_API_KEY' },
    { id: 'hyperbolic', baseUrl: 'https://api.hyperbolic.xyz/v1', envKey: 'HYPERBOLIC_API_KEY' },
    { id: 'lambda', baseUrl: 'https://api.lambda.ai/v1', envKey: 'LAMBDA_API_KEY' },
    { id: 'novita', baseUrl: 'https://api.novita.ai/v3/openai', envKey: 'NOVITA_API_KEY' },
    { id: 'deepinfra', baseUrl: 'https://api.deepinfra.com/v1/openai', envKey: 'DEEPINFRA_API_KEY' },
    { id: 'sambanova', baseUrl: 'https://api.sambanova.ai/v1', envKey: 'SAMBANOVA_API_KEY' },
  ];

  for (const expected of NEW) {
    it(`${expected.id}: preset has the correct baseUrl + envKey`, () => {
      const preset = getProviderPreset(expected.id);
      expect(preset?.baseUrl).toBe(expected.baseUrl);
      expect(preset?.envKey).toBe(expected.envKey);
      expect(preset?.models.some((m) => m.default)).toBe(true);
    });
  }

  it('perplexity is a plain preset (its wire shape matches the shared driver)', () => {
    expect(getProviderPreset('perplexity')?.api).toBe('openai-compatible');
  });

  it('cohere uses the dedicated driver api kind', () => {
    expect(getProviderPreset('cohere')?.api).toBe('cohere');
    process.env.COHERE_API_KEY = 'cohere-test-key';
    expect(createProvider('cohere')).toBeInstanceOf(CohereProvider);
  });
});

describe('Cohere driver', () => {
  it('maps tools to the v2 function envelope and parses text + tool calls', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new CohereProvider({
      apiKey: 'test-key',
      fetchFn: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return jsonResponse({
          message: {
            content: [{ type: 'text', text: 'working' }],
            tool_calls: [
              { id: 'tc1', function: { name: 'deploy', arguments: '{"env":"prod"}' } },
            ],
          },
          usage: { tokens: { input_tokens: 5, output_tokens: 3 } },
        });
      }) as typeof fetch,
    });
    const res = await provider.chat(
      [{ role: 'user', content: 'deploy please' }],
      [
        {
          name: 'deploy',
          description: 'Deploy.',
          parameters: { type: 'object' },
          handler: async () => ({}),
        },
      ],
      { model: 'command-a-03-2025' },
    );
    const tools = bodies[0]!.tools as Array<{ type: string; function: { name: string } }>;
    expect(tools[0]!.type).toBe('function');
    expect(tools[0]!.function.name).toBe('deploy');
    expect(res.content).toBe('working');
    expect(res.toolCalls).toEqual([{ id: 'tc1', name: 'deploy', args: { env: 'prod' } }]);
    expect(res.usage.totalTokens).toBe(8);
  });
});

describe('.env chain (#12)', () => {
  function tempFiles(): { dir: string; configEnv: string; projectEnv: string; localJson: string } {
    const dir = mkdtempSync(join(tmpdir(), 'closure-env-'));
    return {
      dir,
      configEnv: join(dir, 'config.env'),
      projectEnv: join(dir, 'project.env'),
      localJson: join(dir, 'providers.local.json'),
    };
  }

  it('parseDotEnv handles export, quotes, comments, and junk lines', () => {
    const parsed = parseDotEnv(
      [
        '# comment',
        'PLAIN=one',
        'export EXPORTED=two',
        'DOUBLE="a\\nb"',
        "SINGLE='literal \\n'",
        'TRAILING=value # comment',
        'not a line',
        '=nokey',
        '9BAD=x',
        '',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      PLAIN: 'one',
      EXPORTED: 'two',
      DOUBLE: 'a\nb',
      SINGLE: 'literal \\n',
      TRAILING: 'value',
    });
  });

  it('precedence: real env > config .env > project .env > providers.local.json', () => {
    const f = tempFiles();
    writeFileSync(f.configEnv, 'GROQ_API_KEY=config-env-key\n');
    writeFileSync(f.projectEnv, 'GROQ_API_KEY=project-env-key\n');
    writeFileSync(f.localJson, JSON.stringify({ GROQ_API_KEY: 'local-json-key' }));
    process.env.KRIYADOT_CONFIG_ENV_FILE = f.configEnv;
    process.env.KRIYADOT_PROJECT_ENV_FILE = f.projectEnv;
    process.env.PROVIDERS_FILE = f.localJson;

    // config .env beats project .env and local json
    expect(resolveApiKey('groq')).toBe('config-env-key');
    // project .env beats local json once config is gone
    writeFileSync(f.configEnv, '# empty\n');
    expect(resolveApiKey('groq')).toBe('project-env-key');
    // local json is the last fallback
    writeFileSync(f.projectEnv, '# empty\n');
    expect(resolveApiKey('groq')).toBe('local-json-key');
    // real env beats everything and is never overridden by .env files
    writeFileSync(f.configEnv, 'GROQ_API_KEY=config-env-key\n');
    process.env.GROQ_API_KEY = 'real-env-key';
    expect(resolveApiKey('groq')).toBe('real-env-key');
  });
});

describe('Anthropic retry/timeout (#11)', () => {
  function anthropic(fetchFn: typeof fetch): AnthropicProvider {
    return new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'test-key',
      fetchFn,
      sleepFn: async () => undefined,
    });
  }

  it('retries 5xx up to maxRetries and then succeeds', async () => {
    let calls = 0;
    const retries: number[] = [];
    const provider = anthropic((async () => {
      calls++;
      if (calls <= 2) return jsonResponse('boom', 500);
      return jsonResponse({
        content: [{ type: 'text', text: 'recovered' }],
        usage: { input_tokens: 1, output_tokens: 2 },
      });
    }) as typeof fetch);
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], {
      model: 'claude-x',
      maxRetries: 3,
      onRetry: (attempt) => retries.push(attempt),
    });
    expect(res.content).toBe('recovered');
    expect(calls).toBe(3);
    expect(retries).toEqual([1, 2]);
  });

  it('maxRetries: 0 means a single attempt', async () => {
    let calls = 0;
    const provider = anthropic((async () => {
      calls++;
      return jsonResponse('boom', 500);
    }) as typeof fetch);
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'claude-x', maxRetries: 0 }),
    ).rejects.toThrow(/500/);
    expect(calls).toBe(1);
  });

  it('does not retry on 4xx', async () => {
    let calls = 0;
    const provider = anthropic((async () => {
      calls++;
      return jsonResponse('bad request', 400);
    }) as typeof fetch);
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'claude-x', maxRetries: 3 }),
    ).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it('honors timeoutMs: an aborting fetch fails fast without retries', async () => {
    let calls = 0;
    const provider = anthropic((async (_url: unknown, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as typeof fetch);
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], [], {
        model: 'claude-x',
        timeoutMs: 10,
        maxRetries: 3,
      }),
    ).rejects.toThrow(/abort/i);
    expect(calls).toBe(1);
  });
});

describe('Anthropic native structured output (#108)', () => {
  it('forces the __structured_output tool and returns its input as content', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const provider = new AnthropicProvider({
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: 'test-key',
      fetchFn: (async (_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return jsonResponse({
          content: [
            {
              type: 'tool_use',
              id: 's1',
              name: STRUCTURED_OUTPUT_TOOL_NAME,
              input: { ok: true, n: 3 },
            },
          ],
          usage: { input_tokens: 4, output_tokens: 5 },
        });
      }) as typeof fetch,
    });
    const schema = {
      type: 'object',
      properties: { ok: { type: 'boolean' }, n: { type: 'number' } },
      required: ['ok'],
    };
    const res = await provider.chat([{ role: 'user', content: 'answer' }], [], {
      model: 'claude-x',
      responseFormat: { type: 'json_schema', schema },
    });
    expect(bodies[0]!.tool_choice).toEqual({ type: 'tool', name: STRUCTURED_OUTPUT_TOOL_NAME });
    const tools = bodies[0]!.tools as Array<{ name: string; input_schema: unknown }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
    expect(tools[0]!.input_schema).toEqual(schema);
    expect(res.content).toBe('{"ok":true,"n":3}');
    expect(res.toolCalls).toEqual([]);
  });
});

describe('Bedrock retry/timeout (#11)', () => {
  function bedrock(fetchFn: typeof fetch): BedrockProvider {
    return new BedrockProvider({
      region: 'us-east-1',
      accessKeyId: 'AKID',
      secretAccessKey: 'secret',
      fetchFn,
      sleepFn: async () => undefined,
    });
  }

  it('retries throttling (429) with backoff and then succeeds', async () => {
    let calls = 0;
    const provider = bedrock((async () => {
      calls++;
      if (calls <= 2) return jsonResponse('{"message":"slow down"}', 429);
      return jsonResponse({
        output: { message: { content: [{ text: 'recovered' }] } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
    }) as typeof fetch);
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], {
      model: 'amazon.nova-pro-v1:0',
      maxRetries: 2,
    });
    expect(res.content).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('gives up after maxRetries on persistent 5xx', async () => {
    let calls = 0;
    const provider = bedrock((async () => {
      calls++;
      return jsonResponse('boom', 500);
    }) as typeof fetch);
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'x', maxRetries: 1 }),
    ).rejects.toThrow(/Bedrock Converse failed \(500\)/);
    expect(calls).toBe(2);
  });

  it('honors timeoutMs via the fetch signal', async () => {
    let calls = 0;
    const provider = bedrock((async (_url: unknown, init?: RequestInit) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as typeof fetch);
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], [], {
        model: 'x',
        timeoutMs: 10,
        maxRetries: 3,
      }),
    ).rejects.toThrow(/abort/i);
    expect(calls).toBe(1);
  });
});

describe('Bedrock native structured output (#108)', () => {
  it('buildConverseRequest forces the structured tool instead of a prompt contract', () => {
    const req = buildConverseRequest(
      [{ role: 'user', content: 'answer' }],
      [],
      {
        responseFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
      },
    );
    const toolConfig = req.toolConfig as {
      tools: Array<{ toolSpec: { name: string; inputSchema: { json: unknown } } }>;
      toolChoice: unknown;
    };
    expect(toolConfig.toolChoice).toEqual({ tool: { name: '__structured_output' } });
    expect(toolConfig.tools).toHaveLength(1);
    expect(toolConfig.tools[0]!.toolSpec.inputSchema.json).toEqual({
      type: 'object',
      properties: { ok: { type: 'boolean' } },
    });
    // No prompt-append contract remains in the system blocks.
    expect(JSON.stringify(req.system ?? [])).not.toMatch(/Respond with a single JSON/);
  });

  it('parseConverseResponse returns the forced tool input as content when structured', () => {
    const parsed = parseConverseResponse(
      {
        output: {
          message: {
            content: [
              { toolUse: { toolUseId: 's1', name: '__structured_output', input: { ok: true } } },
            ],
          },
        },
        usage: { inputTokens: 2, outputTokens: 2 },
      },
      { structured: true },
    );
    expect(parsed.content).toBe('{"ok":true}');
    expect(parsed.toolCalls).toEqual([]);
  });
});

describe('OVHcloud anonymous lane (free-LLM #1)', () => {
  function ovhFetch(sequence: Response[], seen: Array<{ headers: Record<string, string>; body: Record<string, unknown> }>): typeof fetch {
    let i = 0;
    return (async (_url: unknown, init?: RequestInit) => {
      seen.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return sequence[Math.min(i++, sequence.length - 1)]!;
    }) as typeof fetch;
  }

  it('rotates to the next model on 429 and never sends an Authorization header', async () => {
    const seen: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const provider = new OvAnonymousProvider({
      fetchFn: ovhFetch(
        [
          jsonResponse('rate limited', 429),
          jsonResponse({
            choices: [{ message: { content: 'hello from ovh' } }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
          }),
        ],
        seen,
      ),
    });
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'gpt-oss-120b' });
    expect(res.content).toBe('hello from ovh');
    expect(seen).toHaveLength(2);
    expect(seen[0]!.body.model).toBe('gpt-oss-120b');
    expect(seen[1]!.body.model).toBe('Qwen3.6-27B');
    for (const call of seen) {
      expect(call.headers).not.toHaveProperty('Authorization');
      expect(call.headers).not.toHaveProperty('authorization');
    }
    expect(provider.lastCallAt('gpt-oss-120b')).toBeTypeOf('number');
  });

  it('pacing: a model called inside its window is skipped on the next call', async () => {
    const seen: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const provider = new OvAnonymousProvider({
      now: () => 1_000_000,
      fetchFn: ovhFetch(
        [
          jsonResponse({ choices: [{ message: { content: 'one' } }] }),
          jsonResponse({ choices: [{ message: { content: 'two' } }] }),
        ],
        seen,
      ),
    });
    await provider.chat([{ role: 'user', content: 'a' }], [], { model: 'gpt-oss-120b' });
    await provider.chat([{ role: 'user', content: 'b' }], [], { model: 'gpt-oss-120b' });
    expect(seen[0]!.body.model).toBe('gpt-oss-120b');
    expect(seen[1]!.body.model).toBe('Qwen3.6-27B');
  });

  it('preset metadata: keyless with the exact limits note', () => {
    const preset = getProviderPreset('ovh-anonymous');
    expect(preset?.keyless).toBe(true);
    expect(preset?.limitsNote).toBe(
      'Anonymous lane: 2 requests/min per model (shared) — modest limits',
    );
    expect(preset?.baseUrl).toBe('https://oai.endpoints.kepler.ai.cloud.ovh.net/v1');
    expect(preset?.models.map((m) => m.id)).toEqual([
      'gpt-oss-120b',
      'Qwen3.6-27B',
      'Meta-Llama-3_3-70B-Instruct',
    ]);
    expect(createProvider('ovh-anonymous')).toBeInstanceOf(OvAnonymousProvider);
  });
});

describe('LLM7 anonymous lane (free-LLM #2)', () => {
  it('preset metadata: keyless + bestEffort with the honest limits note', () => {
    const preset = getProviderPreset('llm7-anonymous');
    expect(preset?.keyless).toBe(true);
    expect(preset?.bestEffort).toBe(true);
    expect(preset?.limitsNote).toBe('~60 requests/hour per IP (unverified, best-effort)');
    expect(preset?.baseUrl).toBe('https://api.llm7.io/v1');
  });

  it('factory builds it with no key, and the wire request carries no Authorization header', async () => {
    const provider = createProvider('llm7-anonymous');
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);

    const seenHeaders: Array<Record<string, string>> = [];
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const direct = new OpenAICompatibleProvider({
      providerId: 'llm7-anonymous',
      baseUrl: 'https://api.llm7.io/v1',
      apiKey: '',
      omitAuthHeader: true,
      fetchFn: (async (_url: unknown, init?: RequestInit) => {
        seenHeaders.push((init?.headers ?? {}) as Record<string, string>);
        return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }) as typeof fetch,
    });
    const res = await direct.chat([{ role: 'user', content: 'hi' }], [], { model: 'default' });
    expect(res.content).toBe('hi');
    expect(seenHeaders[0]).not.toHaveProperty('Authorization');
  });
});

describe('AI Horde driver (free-LLM #3)', () => {
  function hordeFetch(calls: Array<{ url: string; body?: Record<string, unknown> }>): typeof fetch {
    let polls = 0;
    return (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push({
        url: u,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      });
      if (u.endsWith('/generate/text/async')) return jsonResponse({ id: 'job-1' });
      polls++;
      if (polls < 2) return jsonResponse({ done: false, faulted: false });
      return jsonResponse({ done: true, faulted: false, generations: [{ text: 'horde reply' }] });
    }) as typeof fetch;
  }

  it('submit → poll completes; anonymous token cap is applied on the wire', async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const provider = new AiHordeProvider({
      fetchFn: hordeFetch(calls),
      pollIntervalMs: 0,
      sleepFn: async () => undefined,
    });
    const res = await provider.chat([{ role: 'user', content: 'hello' }], [], {
      model: 'koboldcpp',
      maxTokens: 4096,
    });
    expect(res.content).toBe('horde reply');
    const submit = calls.find((c) => c.url.endsWith('/generate/text/async'));
    const params = submit!.body!.params as { max_length: number };
    expect(params.max_length).toBe(512);
  });

  it('rejects tool-calling requests with a clear error and never fetches', async () => {
    let fetched = false;
    const provider = new AiHordeProvider({
      fetchFn: (async () => {
        fetched = true;
        return jsonResponse({});
      }) as typeof fetch,
    });
    await expect(
      provider.chat(
        [{ role: 'user', content: 'use a tool' }],
        [
          {
            name: 'x',
            description: 'x',
            parameters: { type: 'object' },
            handler: async () => ({}),
          },
        ],
        { model: 'koboldcpp' },
      ),
    ).rejects.toThrow('AI Horde does not support tool calls — plain chat only');
    expect(fetched).toBe(false);
  });

  it('token cap: 512 anonymous, uncapped with a user key', () => {
    expect(new AiHordeProvider({}).effectiveMaxTokens(4096)).toBe(512);
    expect(new AiHordeProvider({}).effectiveMaxTokens()).toBe(512);
    expect(new AiHordeProvider({ apiKey: 'my-own-key' }).effectiveMaxTokens(4096)).toBe(4096);
  });

  it('factory constructs the driver with no key configured', () => {
    expect(createProvider('aihorde')).toBeInstanceOf(AiHordeProvider);
    expect(getProviderPreset('aihorde')?.keyless).toBe(true);
  });
});

describe('Pollinations BYOK preset (free-LLM #4)', () => {
  it('is bring-your-own-key only: not keyless, never a default', () => {
    const preset = getProviderPreset('pollinations');
    expect(preset?.byo).toBe(true);
    expect(preset?.keyless).toBeUndefined();
    expect(preset?.baseUrl).toBe('https://gen.pollinations.ai/v1');
    expect(preset?.envKey).toBe('POLLINATIONS_API_KEY');
    expect(preset?.notes).toMatch(/no longer offers a keyless/i);
  });

  it('requires the user key and constructs the shared driver with it', () => {
    expect(() => createProvider('pollinations')).toThrow(/POLLINATIONS_API_KEY/);
    process.env.POLLINATIONS_API_KEY = 'user-own-key';
    const provider = createProvider('pollinations');
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.providerId).toBe('pollinations');
  });
});

describe('keyless-stack descriptor (free-LLM)', () => {
  it('orders the chain ollama → ovh → llm7 → aihorde with honest metadata', () => {
    expect(KEYLESS_FALLBACK_CHAIN.map((l) => l.id)).toEqual([
      'ollama-local',
      'ovh-anonymous',
      'llm7-anonymous',
      'aihorde',
    ]);
    expect(KEYLESS_FALLBACK_CHAIN.map((l) => l.guarantee)).toEqual([
      'guaranteed',
      'shared',
      'best-effort',
      'chat-only',
    ]);
    expect(keylessProviderOrder()).toEqual(['ollama', 'ovh-anonymous', 'llm7-anonymous', 'aihorde']);
  });

  it('tool-use chains exclude the chat-only AI Horde lane', () => {
    expect(keylessChain({ toolUse: true }).map((l) => l.id)).toEqual([
      'ollama-local',
      'ovh-anonymous',
      'llm7-anonymous',
    ]);
    expect(keylessChain().map((l) => l.id)).toHaveLength(4);
  });
});
