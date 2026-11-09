// SPDX-License-Identifier: Apache-2.0
// Selection integrity (2026-11-09 field reports): an explicit model
// selection is HONORED or REFUSED LOUDLY — never silently substituted
// with the free lane. Covers the pure decision function and full runtime
// turns: (a) explicit no-key pick -> refusal, no lane call; (b) refusal
// then explicit free-lane pick -> answers, no warning; (c) explicit OVH
// pick -> answers, no warning; (d) no selection + keyless bot default ->
// fallback WITH a notice that names it as the bot's default; (e)
// explicit working keyed pick -> answers, no notice; (6) Universal+Coder:
// model-only OVH pick while the routed bot's default (groq) is keyless
// -> answers on OVH with NO fallback notice; plus the subscription
// driver-failure refusal (no raw traceback, no lane call).

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  decideKeylessFallback,
  ProviderSelectionRefusedError,
  reasonFromConfigError,
  selectionMatchesLane,
} from '../src/failover.js';
import { AgentRuntime } from '../src/runtime.js';
import type { GovernanceGateway, GovernanceDecision } from '../src/governance.js';
import type { BotConfig, StreamEvent } from '../src/types.js';
import { grantBridgeConsent, resetBridgeConsent, resetCliIdentityCache } from '../src/providers/cli-bridge.js';

class FakeGateway implements GovernanceGateway {
  async classify(): Promise<GovernanceDecision> { return 'allow'; }
  async evaluate(): Promise<{ decision: GovernanceDecision }> { return { decision: 'allow' }; }
  async awaitDecision(): Promise<'approved' | 'denied'> { return 'approved'; }
  decide(): void {}
  audit(): void {}
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

const ENV_KEYS = ['GROQ_API_KEY', 'KRIYADOT_KEYLESS_FALLBACK', 'HOME', 'PATH', 'PROVIDERS_FILE'];
const saved = new Map<string, string | undefined>();
for (const k of ENV_KEYS) saved.set(k, process.env[k]);

let fetchUrls: string[] = [];

function stubFetch() {
  fetchUrls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    fetchUrls.push(url);
    if (url.includes('11434')) throw new Error('ECONNREFUSED'); // no local Ollama
    if (url.includes('api.groq.com')) {
      // The OpenAI-compatible driver streams: answer with SSE chunks.
      const sse = [
        `data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: 'answer via groq' }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 } })}`,
        'data: [DONE]',
        '',
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (url.includes('ovh.net')) {
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          choices: [{ index: 0, message: { role: 'assistant', content: 'answer via ovh' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
}

function makeRuntime() {
  return new AgentRuntime({
    dbPath: ':memory:', skillsDir: '/tmp/no-skills',
    governance: new FakeGateway(), toolRegistry: new Map(), defaultProviderId: 'groq',
  } as never);
}

const BOT: BotConfig = {
  id: 'coder', name: 'Coder', description: '', systemPrompt: 'sys',
  provider: 'groq', model: 'gpt-oss-120b', skills: [], tools: [], mcpServers: [],
};

function turnText(events: StreamEvent[]): string {
  return events.filter((e) => e.type === 'token').map((e) => (e as { content: string }).content).join('');
}

function keylessNotices(events: StreamEvent[]): string[] {
  return events
    .filter((e) => e.type === 'notice' && (e as { kind?: string }).kind === 'keyless-fallback')
    .map((e) => (e as { message: string }).message);
}

beforeEach(() => {
  delete process.env.GROQ_API_KEY;
  delete process.env.KRIYADOT_KEYLESS_FALLBACK;
  stubFetch();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  resetBridgeConsent();
  resetCliIdentityCache();
});

describe('decideKeylessFallback (pure)', () => {
  const lane = { providerId: 'ovh-anonymous', model: 'gpt-oss-120b', laneName: 'ovh-anonymous', limitsNote: 'Shared lane.' };
  const cfgErr = new Error('Missing GROQ_API_KEY: set it');

  it('explicit groq pick, no key -> refuse (case 1/a)', () => {
    const d = decideKeylessFallback({
      explicitSelection: true, selectedProviderId: 'groq', selectedModel: 'llama-3.3-70b',
      resolvedProviderId: 'groq', constructionError: cfgErr, lane,
    });
    expect(d.action).toBe('refuse');
    if (d.action === 'refuse') {
      expect(d.refusal).toBeInstanceOf(ProviderSelectionRefusedError);
      expect(d.refusal.message).toMatch(/You picked/);
      expect(d.refusal.message).toMatch(/no API key is configured/);
    }
  });

  it('explicit OVH pick honored by the lane -> run silent (case 2/c)', () => {
    const d = decideKeylessFallback({
      explicitSelection: true, selectedProviderId: 'ovh-anonymous', selectedModel: 'gpt-oss-120b',
      resolvedProviderId: 'groq', constructionError: cfgErr, lane,
    });
    expect(d.action).toBe('run-silent');
  });

  it('model-only OVH pick honored by the lane model -> run silent (Universal+Coder, case 6)', () => {
    const d = decideKeylessFallback({
      explicitSelection: true, selectedModel: 'gpt-oss-120b',
      resolvedProviderId: 'groq', constructionError: cfgErr, lane,
    });
    expect(d.action).toBe('run-silent');
  });

  it('no explicit selection -> notice names the BOT DEFAULT (case 5/d)', () => {
    const d = decideKeylessFallback({
      explicitSelection: false, resolvedProviderId: 'groq', constructionError: cfgErr, lane,
    });
    expect(d.action).toBe('run-with-notice');
    if (d.action === 'run-with-notice') {
      expect(d.notice).toMatch(/This bot's default provider "groq"/);
      expect(d.notice).toMatch(/ovh-anonymous\/gpt-oss-120b/);
    }
  });

  it('selectionMatchesLane: combined provider/model id counts', () => {
    expect(selectionMatchesLane({
      selectedModel: 'ovh-anonymous/gpt-oss-120b', laneProviderId: 'ovh-anonymous', laneModel: 'gpt-oss-120b',
    })).toBe(true);
    expect(selectionMatchesLane({
      selectedProviderId: 'opencode-zen', selectedModel: 'muse-spark', laneProviderId: 'ovh-anonymous', laneModel: 'gpt-oss-120b',
    })).toBe(false);
  });

  it('reasonFromConfigError phrases missing keys plainly', () => {
    expect(reasonFromConfigError(new Error('Missing OPENCODE_ZEN_API_KEY: x'))).toMatch(/no API key is configured/);
  });
});

describe('runtime turns', () => {
  it('(a) explicit no-key selection -> refusal, and the free lane is NEVER called', async () => {
    const rt = makeRuntime();
    const events: StreamEvent[] = [];
    await expect(
      rt.runTurn({
        bot: BOT, message: 'hi', sessionId: 'sel-a',
        providerId: 'groq', model: 'llama-3.3-70b-versatile',
        explicitSelection: true, selectedProviderId: 'groq', selectedModel: 'llama-3.3-70b-versatile',
        onEvent: (e) => { events.push(e); },
      }),
    ).rejects.toBeInstanceOf(ProviderSelectionRefusedError);
    expect(fetchUrls.some((u) => u.includes('ovh.net'))).toBe(false);
    expect(turnText(events)).toBe('');
    rt.close();
  });

  it('(b) after a refusal, explicitly picking the free lane answers from it with NO warning', async () => {
    const rt = makeRuntime();
    const events: StreamEvent[] = [];
    const usage = await rt.runTurn({
      bot: BOT, message: 'hi', sessionId: 'sel-b',
      providerId: 'ovh-anonymous', model: 'gpt-oss-120b',
      explicitSelection: true, selectedProviderId: 'ovh-anonymous', selectedModel: 'gpt-oss-120b',
      onEvent: (e) => { events.push(e); },
    });
    expect(turnText(events)).toContain('answer via ovh');
    expect(keylessNotices(events)).toEqual([]);
    expect(usage.totalTokens).toBeGreaterThan(0);
    rt.close();
  });

  it('(d) no explicit selection + keyless bot default -> fallback works, notice names the default', async () => {
    const rt = makeRuntime();
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: BOT, message: 'hi', sessionId: 'sel-d',
      onEvent: (e) => { events.push(e); },
    });
    expect(turnText(events)).toContain('answer via ovh');
    const notices = keylessNotices(events);
    expect(notices.length).toBe(1);
    expect(notices[0]).toMatch(/This bot's default provider "groq" has no API key configured/);
    rt.close();
  });

  it('(e) explicit selection of a working keyed provider -> answers from it, no notice', async () => {
    process.env.GROQ_API_KEY = 'gsk-test-key';
    const rt = makeRuntime();
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: BOT, message: 'hi', sessionId: 'sel-e',
      providerId: 'groq', model: 'llama-3.3-70b-versatile',
      explicitSelection: true, selectedProviderId: 'groq', selectedModel: 'llama-3.3-70b-versatile',
      onEvent: (e) => { events.push(e); },
    });
    expect(turnText(events)).toContain('answer via groq');
    expect(keylessNotices(events)).toEqual([]);
    rt.close();
  });

  it('(6) Universal+Coder: model-only OVH pick, routed bot default groq keyless -> OVH answers, NO notice', async () => {
    const rt = makeRuntime();
    const events: StreamEvent[] = [];
    await rt.runTurn({
      bot: BOT, message: 'hi', sessionId: 'sel-6',
      model: 'gpt-oss-120b',
      explicitSelection: true, selectedModel: 'gpt-oss-120b',
      onEvent: (e) => { events.push(e); },
    });
    expect(turnText(events)).toContain('answer via ovh');
    expect(keylessNotices(events)).toEqual([]);
    rt.close();
  });

  it.runIf(process.platform !== 'win32')('(4) explicit ChatGPT subscription pick whose CLI driver fails -> loud refusal, summarized, no lane call', async () => {
    // A REAL codex CLI (identity-correct) that crashes on `exec` with a
    // Python-style traceback on stderr — the summary must reach the user,
    // never the traceback, and the free lane must not answer instead.
    const fakeHome = mkdtempSync(join(tmpdir(), 'sel-codex-home-'));
    const fakeBin = mkdtempSync(join(tmpdir(), 'sel-codex-bin-'));
    mkdirSync(join(fakeHome, '.codex'), { recursive: true });
    writeFileSync(join(fakeHome, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-codex-test' }));
    const script = [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "codex-cli 0.0.0-test"; exit 0; fi',
      'if [ "$1" = "login" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
      'if [ "$1" = "debug" ]; then exit 0; fi',
      'echo "Traceback (most recent call last):" >&2',
      'echo "  File \\"x.py\\", line 1, in <module>" >&2',
      'echo "ImportError: boom" >&2',
      'exit 1',
      '',
    ].join('\n');
    const binPath = join(fakeBin, 'codex');
    writeFileSync(binPath, script);
    chmodSync(binPath, 0o755);
    process.env.HOME = fakeHome;
    process.env.PATH = fakeBin;
    process.env.PROVIDERS_FILE = join(tmpdir(), 'sel-no-providers.json');
    grantBridgeConsent('codex');

    const bot: BotConfig = { ...BOT, provider: 'codex-subscription', model: 'gpt-5' };
    const rt = makeRuntime();
    const events: StreamEvent[] = [];
    const err = await rt.runTurn({
      bot, message: 'hi', sessionId: 'sel-4',
      providerId: 'codex-subscription', model: 'gpt-5',
      explicitSelection: true, selectedProviderId: 'codex-subscription', selectedModel: 'gpt-5',
      onEvent: (e) => { events.push(e); },
    }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderSelectionRefusedError);
    const msg = (err as Error).message;
    expect(msg).toMatch(/You picked/);
    expect(msg).not.toMatch(/Traceback/);
    expect(fetchUrls.some((u) => u.includes('ovh.net'))).toBe(false);
    // The driver streams its "[external agent CLI …]" marker before the
    // exit code is known; no ANSWER content (and no traceback) may stream.
    expect(turnText(events)).not.toMatch(/answer via|Traceback|ImportError/);
    rt.close();
  });
});
