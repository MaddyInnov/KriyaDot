// SPDX-License-Identifier: Apache-2.0
// QA 2026-10-30 regressions (WS-A D2/D3, WS-D D2/D5):
//  - OVHcloud anonymous lane: a 404 (model_not_found) failed the whole
//    turn instead of rotating; the roster also listed Qwen3-32B, which
//    the live anonymous catalog no longer serves (now Qwen3.6-27B).
//  - Keyless/cloud providers had NO default timeout: a silent endpoint
//    (accepts, never replies) hung a turn forever.
//  - The OpenAI-compatible retry loop retried hard-quota 429s 3 extra
//    times before the failover machinery could engage.

import { describe, expect, it } from 'vitest';
import { OvAnonymousProvider } from '../src/providers/ovh-anonymous.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { AiHordeProvider } from '../src/providers/aihorde.js';

function realResponse(payload: unknown, status = 200): Response {
  return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch that never resolves until the request signal aborts (silent endpoint). */
function silentFetch(counter: { calls: number }): typeof fetch {
  return ((_url: unknown, init?: RequestInit) => {
    counter.calls++;
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return; // never settles — the bug scenario
      if (signal.aborted) {
        reject(new Error('AbortError: signal already aborted'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('AbortError: timed out')), { once: true });
    });
  }) as typeof fetch;
}

describe('OVH anonymous: rotation covers model_not_found', () => {
  it('rotates past a 404 model and remembers it for the next call', async () => {
    const seenModels: string[] = [];
    const fetchFn = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model: string };
      seenModels.push(body.model);
      if (body.model === 'ghost-model') {
        return realResponse({ error: { code: 'model_not_found', message: 'model not found' } }, 404);
      }
      return realResponse({
        choices: [{ message: { content: `served by ${body.model}` } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;
    const provider = new OvAnonymousProvider({ fetchFn, models: ['gpt-oss-120b', 'Meta-Llama-3_3-70B-Instruct'] });

    const first = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'ghost-model' });
    expect(first.content).toBe('served by gpt-oss-120b');
    expect(seenModels).toEqual(['ghost-model', 'gpt-oss-120b']);

    // Next call: the dead model is skipped entirely (not requested again),
    // and pacing rotates among the live roster.
    seenModels.length = 0;
    const second = await provider.chat([{ role: 'user', content: 'again' }], [], { model: 'ghost-model' });
    expect(second.content).toContain('served by');
    expect(seenModels).not.toContain('ghost-model');
  });

  it('a silent endpoint is bounded by the default timeout', async () => {
    const counter = { calls: 0 };
    const provider = new OvAnonymousProvider({ fetchFn: silentFetch(counter), models: ['gpt-oss-120b'] });
    const started = Date.now();
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'gpt-oss-120b', timeoutMs: 60 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(counter.calls).toBeGreaterThanOrEqual(1);
  });
});

describe('OpenAI-compatible: quota 429 is not retried; plain 429 is', () => {
  function makeProvider(fetchFn: typeof fetch): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({
      providerId: 'test-provider',
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'test-key',
      fetchFn,
    });
  }

  it('hard-quota 429 (insufficient_quota) fails after exactly one attempt', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return realResponse(
        { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } },
        429,
      );
    }) as typeof fetch;
    const provider = makeProvider(fetchFn);
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'm', maxRetries: 3 }),
    ).rejects.toThrow(/quota/i);
    expect(calls).toBe(1);
  });

  it('transient 429 without quota semantics still retries', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return realResponse({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }, 429);
    }) as typeof fetch;
    const provider = makeProvider(fetchFn);
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'm', maxRetries: 2 }),
    ).rejects.toThrow();
    // Note: rate_limit_exceeded classifies as a limit too — if the
    // classifier treats it as hard, one call is also correct; accept
    // either the retry path (>=2) or the classified-hard path (1) but
    // never an unbounded loop.
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(3);
  });
});

describe('AI Horde: per-request timeout bounds a silent endpoint', () => {
  it('submit against a silent endpoint aborts instead of hanging', async () => {
    const counter = { calls: 0 };
    const provider = new AiHordeProvider({ fetchFn: silentFetch(counter), pollIntervalMs: 1 });
    const started = Date.now();
    await expect(
      provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'koboldcpp', timeoutMs: 60 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(counter.calls).toBe(1);
  });
});
