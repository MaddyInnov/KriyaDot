// SPDX-License-Identifier: Apache-2.0
// ENGINES workstream tests: ACP fleet presets (Antigravity + Grok /
// Cursor / Gemini / Kimi / Qwen / Droid / Hermes / Cline / dsh), DeepSeek
// thinking shaping, per-engine homes, Claude account profiles, custom
// ACP engines + probe, catalog additions (Mistral / Meta / LM Studio),
// and the local reply timeout. Zero real network, zero real binaries:
// PATH is pointed at empty temp dirs, fetch is stubbed, and the ACP
// probe runs against a stub Node script.

import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acpEngineSessionOptions,
  applyDeepSeekShaping,
  buildEngineSpawnEnv,
  ClaudeProfileStore,
  claudeProfileHasUsableToken,
  claudeProfileSpawnEnv,
  CopilotAcpProvider,
  createAcpEngineProvider,
  createProvider,
  customEngineToPreset,
  DETECTION_ONLY_ACP_NOTES,
  detectAcpEngines,
  deepseekPickerId,
  deepseekWireValue,
  dshReasoningEffort,
  dshSessionConfig,
  engineHomeDir,
  getAcpEnginePreset,
  getProviderPreset,
  grantBridgeConsent,
  isAcpEngineId,
  listAcpEnginePresets,
  LmStudioProvider,
  loadAgentRegistry,
  loadBridgeTokenForClaudeProfile,
  mergeCustomAcpEngines,
  modelsFromSessionConfig,
  NativeCliDriver,
  OllamaProvider,
  probeCustomAcpEngine,
  publicClaudeProfile,
  resetBridgeConsent,
  resolveClaudeConfigDirForBot,
  sanitizeHomeSegment,
  shapeDeepSeekRequest,
  validateCustomAcpEngine,
  validateRegistry,
} from '../src/index.js';
import type { SpawnFn } from '../src/providers/cli-driver.js';

// ---------------------------------------------------------------------------
// ACP fleet presets
// ---------------------------------------------------------------------------

describe('ACP fleet presets', () => {
  it('registers Antigravity as an ACP preset on the agy server (no args)', () => {
    const preset = getAcpEnginePreset('antigravity');
    expect(preset).toBeDefined();
    expect(preset?.command).toBe('agy');
    expect(preset?.acpArgs).toEqual([]);
    expect(preset?.authId).toBe('antigravity');
    expect(preset?.models[0]?.id).toBe('gemini-3.8-flash');
    expect(isAcpEngineId('antigravity')).toBe(true);
    const opts = acpEngineSessionOptions('antigravity', { cwd: '/tmp/ws' });
    expect(opts.command).toBe('agy');
    expect(opts.args).toEqual([]);
  });

  it('registers every ACP-speaking CLI with its documented ACP invocation', () => {
    const expected: Record<string, { command: string; args: string[] }> = {
      grok: { command: 'grok', args: ['agent', 'stdio'] },
      cursor: { command: 'cursor-agent', args: ['acp'] },
      gemini: { command: 'gemini', args: ['--acp'] },
      kimi: { command: 'kimi', args: ['acp'] },
      qwen: { command: 'qwen', args: ['--acp'] },
      droid: { command: 'droid', args: ['exec', '-o', 'acp'] },
      hermes: { command: 'hermes', args: ['acp'] },
      cline: { command: 'cline', args: ['--acp', '--auto-approve', 'false'] },
      'deepseek-harness': { command: 'dsh', args: ['--profile', 'acp'] },
    };
    for (const [id, want] of Object.entries(expected)) {
      const preset = getAcpEnginePreset(id);
      expect(preset, id).toBeDefined();
      expect(preset?.command, id).toBe(want.command);
      expect(preset?.acpArgs, id).toEqual(want.args);
      expect(preset?.models.length, id).toBeGreaterThan(0);
    }
    // The pre-existing presets are untouched.
    expect(getAcpEnginePreset('copilot')?.acpArgs).toEqual(['--acp']);
    expect(getAcpEnginePreset('opencode')?.acpArgs).toEqual(['acp']);
    expect(listAcpEnginePresets().length).toBe(12);
  });

  it('keeps Pi detection-only for ACP (it speaks its own RPC, not ACP)', () => {
    expect(isAcpEngineId('pi')).toBe(false);
    expect(DETECTION_ONLY_ACP_NOTES.pi).toMatch(/not ACP/);
    // …but Pi stays in the detection registry.
    expect(loadAgentRegistry().find((e) => e.id === 'pi')?.acpCompatible).toBe(true);
  });

  it('registry grew by hermes + deepseek-harness and still validates', () => {
    const entries = loadAgentRegistry();
    expect(entries.length).toBe(42);
    expect(validateRegistry(entries)).toEqual([]);
    expect(entries.find((e) => e.id === 'hermes')?.bins).toEqual(['hermes']);
    expect(entries.find((e) => e.id === 'deepseek-harness')?.bins).toEqual(['dsh']);
    expect(entries.find((e) => e.id === 'antigravity')?.acpCompatible).toBe(true);
  });
});

describe('ACP engine detection', () => {
  let dir: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-detect-'));
    savedPath = process.env.PATH;
    process.env.PATH = dir;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports not-installed cleanly when the binaries are absent', () => {
    const found = detectAcpEngines();
    for (const id of ['antigravity', 'grok', 'cursor', 'hermes', 'cline', 'deepseek-harness']) {
      const d = found.find((x) => x.id === id);
      expect(d, id).toBeDefined();
      expect(d?.installed, id).toBe(false);
      expect(d?.path, id).toBeNull();
    }
  });

  it('prefers an installed standalone build over PATH', () => {
    const fakeStandalone = join(dir, 'opencode-standalone');
    const found = detectAcpEngines({
      standalonePath: (id) => (id === 'opencode' ? fakeStandalone : null),
    });
    const oc = found.find((x) => x.id === 'opencode');
    expect(oc?.installed).toBe(true);
    expect(oc?.path).toBe(fakeStandalone);
  });

  it('detects a planted fake grok binary on PATH', () => {
    if (process.platform === 'win32') return;
    const bin = join(dir, 'grok');
    writeFileSync(bin, '#!/bin/sh\necho grok 1.0.0\n');
    chmodSync(bin, 0o755);
    const d = detectAcpEngines().find((x) => x.id === 'grok');
    expect(d?.installed).toBe(true);
    expect(d?.path).toBe(bin);
  });
});

describe('generic ACP engine provider routing', () => {
  it('createAcpEngineProvider handles any preset and ignores non-ACP ids', () => {
    const p = createAcpEngineProvider('agent/kimi/kimi-code/k3', { cwd: process.cwd() });
    expect(p).toBeInstanceOf(CopilotAcpProvider);
    expect(p?.providerId).toBe('agent/kimi/kimi-code/k3');
    expect(p?.engineId).toBe('kimi');
    p?.close();
    expect(createAcpEngineProvider('agent/codex/gpt-5')).toBeNull();
    expect(createAcpEngineProvider('agent/pi/default')).toBeNull();
    expect(createAcpEngineProvider('groq')).toBeNull();
  });

  it('factory routes fleet engines to the ACP provider', () => {
    for (const id of ['agent/grok/grok-4.7', 'agent/antigravity/gemini-3.8-flash', 'agent/cline/cline-default']) {
      const provider = createProvider(id);
      expect(provider, id).toBeInstanceOf(CopilotAcpProvider);
      (provider as CopilotAcpProvider).close();
    }
  });

  it('chats through an injected ACP client and marks output untrusted', async () => {
    const provider = new CopilotAcpProvider({
      engineId: 'qwen',
      model: 'default',
      cwd: process.cwd(),
      createClient: () => ({
        connect: async () => ({ agentName: 'fake-qwen' }),
        promptStream: async (text: string) => ({ text: `echo:${text.length > 0}` }),
        isConnected: () => true,
        close: () => undefined,
      }),
    });
    const result = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'default' });
    expect(result.content).toContain('untrusted');
    expect(result.content).toContain('qwen');
    provider.close();
  });
});

// ---------------------------------------------------------------------------
// DeepSeek depth
// ---------------------------------------------------------------------------

describe('DeepSeek thinking shaping (API surface)', () => {
  it('mode selects chat vs reasoner when no explicit DeepSeek model is pinned', () => {
    expect(shapeDeepSeekRequest('default', { deepseekMode: 'reasoner' })).toMatchObject({
      model: 'deepseek-reasoner',
      thinking: true,
      reasoningEffort: 'high',
    });
    expect(shapeDeepSeekRequest('', { deepseekMode: 'chat' })).toMatchObject({
      model: 'deepseek-chat',
      thinking: false,
    });
    expect(shapeDeepSeekRequest(undefined, undefined)).toMatchObject({ model: 'deepseek-chat', thinking: false });
  });

  it('an explicit DeepSeek model pin wins over the mode', () => {
    expect(shapeDeepSeekRequest('deepseek-chat', { deepseekMode: 'reasoner' }).model).toBe('deepseek-chat');
    expect(shapeDeepSeekRequest('deepseek-reasoner', { deepseekMode: 'chat' }).model).toBe('deepseek-reasoner');
  });

  it('effort passes through for the reasoner and is dropped for chat', () => {
    expect(shapeDeepSeekRequest('deepseek-reasoner', { reasoningEffort: 'low' }).reasoningEffort).toBe('low');
    expect(shapeDeepSeekRequest('deepseek-chat', { reasoningEffort: 'high' }).reasoningEffort).toBeUndefined();
    const body = applyDeepSeekShaping({ model: 'deepseek-chat', reasoning_effort: 'high' }, { deepseekMode: 'chat' });
    expect(body).not.toHaveProperty('reasoning_effort');
  });
});

describe('DeepSeek provider wire shaping (stubbed fetch)', () => {
  function sse(): Response {
    const body = 'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  afterEach(() => vi.unstubAllGlobals());

  it('deepseekMode=reasoner rewrites the wire model; the chat model sends no effort', async () => {
    process.env.DEEPSEEK_API_KEY = 'ds-test-key';
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
        return sse();
      }),
    );
    try {
      const provider = createProvider('deepseek');
      await provider.chat([{ role: 'user', content: 'think' }], [], {
        model: 'deepseek-chat',
        deepseekMode: 'reasoner',
      } as Parameters<typeof provider.chat>[2]);
      expect(calls[0]?.body.model).toBe('deepseek-chat'); // explicit pin wins
      await provider.chat([{ role: 'user', content: 'think' }], [], {
        model: 'default',
        deepseekMode: 'reasoner',
      } as Parameters<typeof provider.chat>[2]);
      expect(calls[1]?.body.model).toBe('deepseek-reasoner');
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });
});

describe('DeepSeek harness (dsh) wire shaping', () => {
  it('picker ids round-trip through the wire pair format', () => {
    expect(deepseekWireValue('deepseek-official/deepseek-v4-flash')).toBe('["deepseek-official","deepseek-v4-flash"]');
    expect(deepseekPickerId('["deepseek-official","deepseek-v4-flash"]')).toBe('deepseek-official/deepseek-v4-flash');
    expect(deepseekPickerId('not json')).toBeNull();
    expect(deepseekPickerId('["only-one"]')).toBeNull();
    expect(deepseekWireValue('bare-model')).toBe('bare-model');
  });

  it('maps model options onto the harness reasoning_effort values', () => {
    expect(dshReasoningEffort({ deepseekMode: 'chat', reasoningEffort: 'high' })).toBe('off');
    expect(dshReasoningEffort({ reasoningEffort: 'low' })).toBe('low');
    expect(dshReasoningEffort({ reasoningEffort: 'medium' })).toBe('high');
    expect(dshReasoningEffort({ reasoningEffort: 'high' })).toBe('max');
    expect(dshReasoningEffort({ deepseekMode: 'reasoner' })).toBe('high');
    expect(dshReasoningEffort(undefined)).toBe('off');
    expect(dshSessionConfig('deepseek-official/deepseek-v4-pro', { reasoningEffort: 'high' })).toEqual([
      { configId: 'model', value: '["deepseek-official","deepseek-v4-pro"]' },
      { configId: 'reasoning_effort', value: 'max' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Per-engine homes
// ---------------------------------------------------------------------------

describe('per-engine homes (env shaping)', () => {
  it('sanitizes ids into single safe segments', () => {
    expect(sanitizeHomeSegment('bot-1')).toBe('bot-1');
    expect(sanitizeHomeSegment('../evil/bot')).not.toContain('/');
    expect(sanitizeHomeSegment('../evil/bot')).not.toContain('..');
    expect(sanitizeHomeSegment('')).toBe('default');
    expect(engineHomeDir('/data', 'bot 1', 'grok')).toBe(join('/data', 'engine-homes', 'bot-1', 'grok'));
  });

  it('overrides HOME on POSIX and USERPROFILE+HOME on Windows', () => {
    const posix = buildEngineSpawnEnv({
      baseEnv: { PATH: '/bin', HOME: '/home/u' },
      dataDir: '/data',
      botId: 'b1',
      engineId: 'claude-code',
      platform: 'linux',
    });
    expect(posix.homeDir).toBe(join('/data', 'engine-homes', 'b1', 'claude-code'));
    expect(posix.env.HOME).toBe(posix.homeDir);
    expect(posix.env.PATH).toBe('/bin');
    const win = buildEngineSpawnEnv({
      baseEnv: { PATH: 'C:\\Windows' },
      dataDir: 'C:\\data',
      botId: 'b1',
      engineId: 'codex',
      platform: 'win32',
    });
    expect(win.env.USERPROFILE).toBe(win.homeDir);
    expect(win.env.HOME).toBe(win.homeDir);
  });

  it('shared-home opt-out leaves the env untouched', () => {
    const shaped = buildEngineSpawnEnv({
      baseEnv: { HOME: '/home/u' },
      dataDir: '/data',
      botId: 'b1',
      engineId: 'grok',
      sharedHome: true,
      platform: 'linux',
    });
    expect(shaped.homeDir).toBeNull();
    expect(shaped.env.HOME).toBe('/home/u');
    expect(shaped.overrides).toEqual({});
  });

  it('the native CLI driver passes the isolated home to spawn', async () => {
    const seenEnvs: Array<Record<string, string> | undefined> = [];
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'done' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ];
    const spawnFn = ((_command: string, _args: string[], opts: { env?: Record<string, string> }) => {
      seenEnvs.push(opts.env);
      const emitter = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = { kill: () => undefined };
      queueMicrotask(() => {
        for (const line of lines) stdout.emit('data', Buffer.from(line + '\n'));
        queueMicrotask(() => emitter.emit('close', 0, null));
      });
      return {
        child: child as unknown as import('node:child_process').ChildProcess,
        stdout: stdout as unknown as NodeJS.ReadableStream,
        stderr: stderr as unknown as NodeJS.ReadableStream,
        done: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
          emitter.on('close', (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
        }),
      };
    }) as unknown as SpawnFn;
    const driver = new NativeCliDriver({
      cliId: 'codex',
      model: 'gpt-5',
      command: 'fake-codex',
      spawnFn,
      timeoutMs: 5000,
      preflightAuthCheck: null,
      engineHome: { dataDir: '/data', botId: 'bot-9' },
    });
    const result = await driver.chat([{ role: 'user', content: 'hi' }], [], { model: 'gpt-5' });
    expect(result.content).toContain('done');
    expect(seenEnvs[0]?.HOME).toBe(join('/data', 'engine-homes', 'bot-9', 'codex'));
  });
});

// ---------------------------------------------------------------------------
// Claude account profiles
// ---------------------------------------------------------------------------

describe('Claude account profiles', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'claude-profiles-'));
  });
  afterEach(() => {
    resetBridgeConsent();
    rmSync(home, { recursive: true, force: true });
  });

  it('validates, stores, and selects profiles; public view carries no secrets', () => {
    const store = new ClaudeProfileStore();
    const work = store.upsert({ id: 'work', label: 'Work Claude', configDir: 'claude-work' }, home);
    expect(work.configDir).toBe(join(home, 'claude-work'));
    store.upsert({ id: 'personal', label: 'Personal', configDir: '/abs/claude-personal' }, home);
    expect(store.list().map((p) => p.id)).toEqual(['personal', 'work']); // label order
    expect(resolveClaudeConfigDirForBot(store.list(), 'work', home)).toBe(join(home, 'claude-work'));
    expect(resolveClaudeConfigDirForBot(store.list(), 'missing', home)).toBe(join(home, '.claude'));
    expect(resolveClaudeConfigDirForBot(store.list(), undefined, home)).toBe(join(home, '.claude'));
    expect(claudeProfileSpawnEnv(store.list(), 'personal')).toEqual({ CLAUDE_CONFIG_DIR: '/abs/claude-personal' });
    expect(claudeProfileSpawnEnv(store.list(), undefined)).toEqual({});
    expect(JSON.stringify(publicClaudeProfile(work))).not.toMatch(/token|secret/i);
    expect(store.remove('work')).toBe(true);
    expect(store.remove('work')).toBe(false);
    expect(() => store.upsert({ id: 'Bad Id!', label: 'x', configDir: 'y' }, home)).toThrow(/invalid profile id/);
  });

  it('the bridge reads the token from the SELECTED profile dir, consent-gated', () => {
    const configDir = join(home, 'claude-work');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-profile-token' } }),
    );
    expect(claudeProfileHasUsableToken(configDir)).toBe(true);
    // No consent → no token, ever.
    expect(loadBridgeTokenForClaudeProfile(configDir)).toBeUndefined();
    grantBridgeConsent('claude');
    expect(loadBridgeTokenForClaudeProfile(configDir)).toBe('sk-ant-oat01-profile-token');
  });
});

// ---------------------------------------------------------------------------
// Custom ACP engines
// ---------------------------------------------------------------------------

const STUB_ACP_AGENT = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'stub-agent' } } }) + '\\n');
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1', configOptions: [
      { id: 'model', type: 'select', currentValue: 'stub-1', options: [
        { value: 'stub-1', name: 'Stub One' },
        { name: 'Group', options: [ { value: 'stub-2', name: 'Stub Two' } ] },
      ] },
    ] } }) + '\\n');
  }
});
`;

describe('custom ACP engines', () => {
  it('validates definitions and refuses shell commands + foreign provider keys', () => {
    const ok = validateCustomAcpEngine({ id: 'My Agent', label: 'My Agent', command: 'my-agent', args: ['acp'] });
    expect(ok.id).toBe('custom-my-agent');
    expect(() => validateCustomAcpEngine({ id: 'x', label: 'x', command: 'my-agent acp' })).toThrow(/single executable/);
    expect(() =>
      validateCustomAcpEngine({ id: 'x', label: 'x', command: 'a', env: { OPENAI_API_KEY: 'sk-x' } }),
    ).toThrow(/refused/);
    expect(() => validateCustomAcpEngine({ id: 'x', label: '', command: 'a' })).toThrow(/label/);
  });

  it('merges customs after presets and never lets a custom shadow a built-in', () => {
    const presets = listAcpEnginePresets();
    const merged = mergeCustomAcpEngines(presets, [
      validateCustomAcpEngine({ id: 'mine', label: 'Mine', command: 'mine', args: [] }),
      { id: 'copilot', label: 'Fake Copilot', command: 'fake', args: [] },
    ]);
    expect(merged.length).toBe(presets.length + 1);
    expect(merged.find((e) => e.id === 'custom-mine')?.custom).toBe(true);
    expect(merged.find((e) => e.id === 'copilot')?.custom).toBe(false);
    const mine = validateCustomAcpEngine({ id: 'mine', label: 'Mine', command: 'mine', args: ['acp'] });
    expect(customEngineToPreset(mine)).toMatchObject({ id: 'custom-mine', command: 'mine', acpArgs: ['acp'] });
  });

  it('parses advertised models out of session config options (groups descend)', () => {
    expect(
      modelsFromSessionConfig([
        { id: 'model', options: [{ value: 'a', name: 'A' }, { options: [{ value: 'b' }] }] },
      ]),
    ).toEqual([
      { id: 'a', name: 'A' },
      { id: 'b', name: 'b' },
    ]);
    expect(modelsFromSessionConfig(undefined)).toEqual([]);
    expect(modelsFromSessionConfig([{ id: 'mode', options: [{ value: 'x' }] }])).toEqual([]);
  });

  it('probes a stub binary over ACP: initialize + session/new model discovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-probe-'));
    const script = join(dir, 'stub-agent.cjs');
    writeFileSync(script, STUB_ACP_AGENT);
    try {
      const engine = validateCustomAcpEngine({
        id: 'stub',
        label: 'Stub',
        command: process.execPath,
        args: [script],
      });
      const result = await probeCustomAcpEngine(engine, { cwd: dir, timeoutMs: 10_000 });
      expect(result.agentName).toBe('stub-agent');
      expect(result.models).toEqual([
        { id: 'stub-1', name: 'Stub One' },
        { id: 'stub-2', name: 'Stub Two' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('probe fails readably for a missing binary', async () => {
    const engine = validateCustomAcpEngine({ id: 'ghost', label: 'Ghost', command: 'definitely-not-a-real-binary-xyz', args: [] });
    await expect(probeCustomAcpEngine(engine, { cwd: process.cwd(), timeoutMs: 5_000 })).rejects.toThrow(/Could not start/);
  });
});

// ---------------------------------------------------------------------------
// Catalog additions + local reply timeout
// ---------------------------------------------------------------------------

describe('catalog additions (Mistral / Meta / LM Studio)', () => {
  it('registers mistral + meta as OpenAI-compatible BYOK presets', () => {
    const mistral = getProviderPreset('mistral');
    expect(mistral?.api).toBe('openai-compatible');
    expect(mistral?.baseUrl).toBe('https://api.mistral.ai/v1');
    expect(mistral?.envKey).toBe('MISTRAL_API_KEY');
    expect(mistral?.models.map((m) => m.id)).toContain('mistral-large-latest');
    const meta = getProviderPreset('meta');
    expect(meta?.api).toBe('openai-compatible');
    expect(meta?.baseUrl).toBe('https://api.meta.ai/v1');
    expect(meta?.envKey).toBe('META_API_KEY');
    expect(meta?.models.map((m) => m.id)).toContain('muse-spark-1.3');
  });

  it('registers lmstudio as a local live-models preset at localhost:1234', () => {
    const lm = getProviderPreset('lmstudio');
    expect(lm?.local).toBe(true);
    expect(lm?.liveModels).toBe(true);
    expect(lm?.baseUrl).toBe('http://localhost:1234/v1');
    expect(lm?.replyTimeoutMs).toBe(300_000);
    expect(getProviderPreset('ollama')?.replyTimeoutMs).toBe(300_000);
    const provider = createProvider('lmstudio');
    expect(provider).toBeInstanceOf(LmStudioProvider);
    expect(provider.providerId).toBe('lmstudio');
  });

  it('LM Studio lists models live from /v1/models (stubbed fetch)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ data: [{ id: 'local-model-a' }, { id: 'local-model-b' }] }),
      })),
    );
    try {
      const provider = new LmStudioProvider({ baseUrl: 'http://localhost:1234/v1' });
      const models = await provider.listModels();
      expect(models.map((m) => m.id)).toEqual(['local-model-a', 'local-model-b']);
      expect(models[0]?.free).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('local reply timeout threading', () => {
  function sse(): Response {
    const body = 'data: {"choices":[{"delta":{"content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  afterEach(() => vi.unstubAllGlobals());

  it('a configured replyTimeoutMs puts an abort signal on the local request; none configured → no signal', async () => {
    const signals: Array<AbortSignal | undefined> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        signals.push(init.signal ?? undefined);
        return sse();
      }),
    );
    const withTimeout = new OllamaProvider({ replyTimeoutMs: 60_000 });
    await withTimeout.chat([{ role: 'user', content: 'hi' }], [], { model: 'llama3.1' });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    const without = new OllamaProvider();
    await without.chat([{ role: 'user', content: 'hi' }], [], { model: 'llama3.1' });
    expect(signals[1]).toBeUndefined();
    // Per-call replyTimeoutMs (from bot modelOptions) also applies.
    await without.chat([{ role: 'user', content: 'hi' }], [], {
      model: 'llama3.1',
      replyTimeoutMs: 5_000,
    } as Parameters<typeof without.chat>[2]);
    expect(signals[2]).toBeInstanceOf(AbortSignal);
  });
});
