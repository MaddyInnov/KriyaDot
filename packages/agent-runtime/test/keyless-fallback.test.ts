// SPDX-License-Identifier: Apache-2.0
// Zero-setup keyless fallback (free-LLM stack): a provider that cannot
// be constructed for a configuration reason (missing key) falls back
// to the keyless chain; other errors and explicit keys never fall back.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createProviderWithKeylessFallback,
  isProviderConfigError,
  resolveKeylessFallback,
  resolveViableKeylessProvider,
} from '../src/providers/factory.js';
import { AgentRuntime } from '../src/runtime.js';
import type { GovernanceGateway, GovernanceDecision } from '../src/governance.js';
import type { BotConfig, StreamEvent } from '../src/types.js';

class FakeGateway implements GovernanceGateway {
  async classify(): Promise<GovernanceDecision> { return 'allow'; }
  async evaluate(): Promise<{ decision: GovernanceDecision }> { return { decision: 'allow' }; }
  async awaitDecision(): Promise<'approved' | 'denied'> { return 'approved'; }
  decide(): void {}
  audit(): void {}
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

const ENV_KEYS = ['GROQ_API_KEY', 'KRIYADOT_KEYLESS_FALLBACK', 'OPENAI_API_KEY'];
const saved = new Map<string, string | undefined>();
for (const k of ENV_KEYS) saved.set(k, process.env[k]);

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

describe('keyless fallback', () => {
  it('isProviderConfigError matches the factory missing-key error only', () => {
    expect(isProviderConfigError(new Error('Missing GROQ_API_KEY: set the GROQ_API_KEY environment variable'))).toBe(true);
    expect(isProviderConfigError(new Error('Unknown provider "nope"'))).toBe(false);
    expect(isProviderConfigError(new Error('socket hang up'))).toBe(false);
  });

  it('falls back to the first keyless lane when the requested provider has no key', () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.KRIYADOT_KEYLESS_FALLBACK;
    const res = createProviderWithKeylessFallback('groq');
    expect(res.fellBack).toBe(true);
    // Chain order: ollama constructs purely, so it is the sync winner.
    expect(res.providerId).toBe('ollama');
    expect(res.model).toBe('qwen3:4b');
    expect(res.lane?.guarantee).toBe('guaranteed');
  });

  it('tool-using turns skip the chat-only AI Horde lane in the chain descriptor', () => {
    const fb = resolveKeylessFallback({ toolUse: true });
    expect(fb).not.toBeNull();
    expect(fb!.providerId).not.toBe('aihorde');
  });

  it('does not fall back when disabled via env', () => {
    delete process.env.GROQ_API_KEY;
    process.env.KRIYADOT_KEYLESS_FALLBACK = '0';
    expect(() => createProviderWithKeylessFallback('groq')).toThrow(/Missing GROQ_API_KEY/);
    expect(resolveKeylessFallback()).toBeNull();
  });

  it('does not fall back for unknown providers', () => {
    expect(() => createProviderWithKeylessFallback('definitely-not-a-provider')).toThrow(/Unknown provider/);
  });

  it('FIRST RUN: a fresh install (no keys anywhere) completes a chat turn on the keyless stack', async () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.KRIYADOT_KEYLESS_FALLBACK;
    const seenAuth: Array<string | null> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = String(input);
      if (url.includes('11434')) throw new Error('ECONNREFUSED'); // no local Ollama
      if (url.includes('ovh.net')) {
        seenAuth.push(init?.headers?.Authorization ?? init?.headers?.authorization ?? null);
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-test',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Hello from the free lane' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }));
    const bot: BotConfig = {
      id: 'b1', name: 'B', description: '', systemPrompt: 'sys',
      provider: 'groq', model: 'gpt-oss-120b', skills: [], tools: [], mcpServers: [],
    };
    const rt = new AgentRuntime({
      dbPath: ':memory:', skillsDir: '/tmp/no-skills',
      governance: new FakeGateway(), toolRegistry: new Map(), defaultProviderId: 'groq',
    } as never);
    const events: StreamEvent[] = [];
    const usage = await rt.runTurn({ bot, message: 'hi', sessionId: 'first-run', onEvent: (e) => { events.push(e); } });
    const text = events.filter((e) => e.type === 'token').map((e) => (e as { content: string }).content).join('');
    expect(text).toContain('Hello from the free lane');
    expect(events.some((e) => e.type === 'notice' && e.kind === 'keyless-fallback')).toBe(true);
    expect(usage.totalTokens).toBeGreaterThan(0);
    // The anonymous lane must never send an Authorization header.
    expect(seenAuth.length).toBeGreaterThan(0);
    expect(seenAuth.every((a) => a === null)).toBe(true);
    rt.close();
  });

  it('viable-provider walk skips a dead Ollama and lands on OVH anonymous', async () => {
    // Ollama probe: listModels fetches http://localhost:11434 — make
    // every fetch fail fast so the probe reports not-viable.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const res = await resolveViableKeylessProvider({ probeTimeoutMs: 50 });
    expect(res).not.toBeNull();
    expect(res!.providerId).toBe('ovh-anonymous');
    expect(res!.lane.guarantee).toBe('shared');
  });
});
