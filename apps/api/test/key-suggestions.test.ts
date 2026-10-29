// SPDX-License-Identifier: Apache-2.0
// Helper key suggestions (§1.7): deterministic ranking over a fixture
// catalog + env, plus the routes shape.

import express from 'express';
import { describe, expect, it } from 'vitest';
import { createKeySuggestionsRouter, rankKeySuggestions } from '../src/key-suggestions.js';

const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', envKey: 'OPENAI_API_KEY', models: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
  { id: 'groq', name: 'Groq', envKey: 'GROQ_API_KEY', models: [{ id: 'a' }] },
  { id: 'ollama', name: 'Ollama', envKey: '', local: true, models: [{ id: 'a' }] },
  { id: 'anthropic', name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', models: [{ id: 'a' }, { id: 'b' }] },
] as never[];

describe('rankKeySuggestions', () => {
  it('ranks the provider unlocking the most models first', () => {
    const out = rankKeySuggestions({ providers: PROVIDERS, env: {}, surfaces: [] });
    expect(out.map((s) => s.key)).toEqual(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GROQ_API_KEY']);
    expect(out[0]).toMatchObject({ provider: 'openai', score: 13 });
    expect(out[0].unlocks[0]).toBe('Provider: OpenAI');
    expect(out[0].unlocks[1]).toContain('3 models');
  });

  it('never suggests present keys or local providers', () => {
    const out = rankKeySuggestions({
      providers: PROVIDERS,
      env: { OPENAI_API_KEY: 'sk-x', GROQ_API_KEY: '  ' },
      surfaces: [],
    });
    // GROQ_API_KEY is whitespace-only → still missing; OPENAI present → gone.
    expect(out.map((s) => s.key)).toEqual(['ANTHROPIC_API_KEY', 'GROQ_API_KEY']);
  });

  it('surfaces rank below big providers but above nothing; ties break by key name', () => {
    const out = rankKeySuggestions({
      providers: [],
      env: {},
      surfaces: [
        { key: 'ZZZ_KEY', unlocks: ['z'], weight: 5 },
        { key: 'AAA_KEY', unlocks: ['a'], weight: 5 },
        { key: 'VOICE_KEY', unlocks: ['v'], weight: 8 },
      ],
    });
    expect(out.map((s) => s.key)).toEqual(['VOICE_KEY', 'AAA_KEY', 'ZZZ_KEY']);
  });

  it('a surface sharing a provider key merges unlocks instead of duplicating', () => {
    const out = rankKeySuggestions({
      providers: PROVIDERS,
      env: {},
      surfaces: [{ key: 'OPENAI_API_KEY', unlocks: ['Voice: realtime voice'], weight: 8 }],
    });
    const openai = out.filter((s) => s.key === 'OPENAI_API_KEY');
    expect(openai).toHaveLength(1);
    expect(openai[0].unlocks).toContain('Voice: realtime voice');
    expect(openai[0].score).toBe(13 + 8);
  });

  it('is deterministic across calls', () => {
    const a = rankKeySuggestions({ providers: PROVIDERS, env: {} });
    const b = rankKeySuggestions({ providers: PROVIDERS, env: {} });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(3); // providers + default surfaces
  });
});

describe('key suggestions route', () => {
  it('GET / returns the ranked suggestions', async () => {
    const app = express();
    app.use(
      '/api/settings/key-suggestions',
      createKeySuggestionsRouter({ getProviders: () => PROVIDERS, getEnv: () => ({}), surfaces: [] }),
    );
    const http = await import('node:http');
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/settings/key-suggestions`);
      const json = (await res.json()) as { ok: boolean; suggestions: Array<{ key: string }> };
      expect(json.ok).toBe(true);
      expect(json.suggestions[0].key).toBe('OPENAI_API_KEY');
    } finally {
      server.close();
    }
  });
});
