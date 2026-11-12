// SPDX-License-Identifier: Apache-2.0
// A9: declarative provider plugins at the runtime layer — a preset
// registered at runtime (as the API host does on plugin install) is
// served by the BUILT-IN OpenAI-compatible driver, appears in the
// catalog listings, and disappears on unregister. The only endpoint is
// a local fake OpenAI-compatible HTTP server (test fixture); zero paid
// APIs, zero external network.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clearPluginProviderPresets,
  createProvider,
  getProviderPreset,
  listPluginProviderPresets,
  listProviderPresets,
  registerPluginProviderPreset,
  unregisterPluginProviderPreset,
  type ProviderPreset,
} from '../src/index.js';

const FAKE_MODELS = [
  { id: 'fake-1', name: 'Fake One' },
  { id: 'fake-2', name: 'Fake Two' },
];

let server: Server;
let baseUrl = '';
const seenAuth: Array<string | undefined> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seenAuth.push(req.headers.authorization);
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: FAKE_MODELS.map((m) => ({ id: m.id })) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { model?: string; messages?: Array<{ content?: string }> };
        const lastUser = [...(parsed.messages ?? [])].reverse().find((m) => typeof m.content === 'string');
        const chunk = {
          choices: [{ delta: { content: `echo:${lastUser?.content ?? ''} via ${parsed.model ?? '?'}` }, finish_reason: null }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        };
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  clearPluginProviderPresets();
  delete process.env.FAKE_LLM_API_KEY;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function fakePreset(overrides: Partial<ProviderPreset> = {}): ProviderPreset {
  return {
    id: 'fake-llm',
    name: 'Fake LLM',
    api: 'openai-compatible',
    baseUrl,
    envKey: 'FAKE_LLM_API_KEY',
    liveModels: true,
    models: FAKE_MODELS.map((m) => ({ ...m })),
    notes: 'Declarative provider installed by plugin "fake-llm-plugin" (test).',
    ...overrides,
  };
}

describe('A9 plugin provider registry', () => {
  it('register → preset visible in catalog + picker listing; createProvider serves models + a chat turn through the built-in driver', async () => {
    process.env.FAKE_LLM_API_KEY = 'test-key-not-real';
    expect(registerPluginProviderPreset(fakePreset(), 'fake-llm-plugin')).toEqual({ ok: true });
    expect(getProviderPreset('fake-llm')?.baseUrl).toBe(baseUrl);
    expect(listProviderPresets().map((p) => p.id)).toContain('fake-llm');
    expect(listPluginProviderPresets()).toHaveLength(1);

    const provider = createProvider('fake-llm');
    const models = await provider.listModels();
    // Live models from the fake server's /models endpoint (not the static roster names).
    expect(models.map((m) => m.id)).toEqual(['fake-1', 'fake-2']);

    const turn = await provider.chat([{ role: 'user', content: 'hello a9' }], [], { model: 'fake-1' });
    expect(turn.content).toBe('echo:hello a9 via fake-1');
    expect(turn.usage.totalTokens).toBe(7);
    // The declared env key was resolved through the credential chain and sent as the bearer.
    expect(seenAuth).toContain('Bearer test-key-not-real');
  });

  it('unregister → provider gone from the catalog and createProvider refuses it', async () => {
    expect(unregisterPluginProviderPreset('fake-llm')).toBe(true);
    expect(getProviderPreset('fake-llm')).toBeUndefined();
    expect(listProviderPresets().map((p) => p.id)).not.toContain('fake-llm');
    expect(() => createProvider('fake-llm')).toThrow(/Unknown provider/);
  });

  it('shadowing is refused: catalog ids, custom-* ids, and another plugin’s id cannot be taken', () => {
    const groq = registerPluginProviderPreset(fakePreset({ id: 'groq' }), 'evil-plugin');
    expect(groq.ok).toBe(false);
    const custom = registerPluginProviderPreset(fakePreset({ id: 'custom-fake' }), 'evil-plugin');
    expect(custom.ok).toBe(false);
    expect(registerPluginProviderPreset(fakePreset(), 'fake-llm-plugin')).toEqual({ ok: true });
    const steal = registerPluginProviderPreset(fakePreset(), 'other-plugin');
    expect(steal.ok).toBe(false);
    // The owner refreshing its own preset is fine.
    expect(registerPluginProviderPreset(fakePreset({ name: 'Fake LLM v2' }), 'fake-llm-plugin')).toEqual({ ok: true });
    expect(getProviderPreset('fake-llm')?.name).toBe('Fake LLM v2');
    unregisterPluginProviderPreset('fake-llm');
  });

  it('a missing API key is an honest configuration error, not a silent keyless call', async () => {
    delete process.env.FAKE_LLM_API_KEY;
    expect(registerPluginProviderPreset(fakePreset(), 'fake-llm-plugin')).toEqual({ ok: true });
    expect(() => createProvider('fake-llm')).toThrow(/Missing FAKE_LLM_API_KEY/);
    unregisterPluginProviderPreset('fake-llm');
  });
});
