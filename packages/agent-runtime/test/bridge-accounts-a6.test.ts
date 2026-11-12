// SPDX-License-Identifier: Apache-2.0
// A6: multiple sign-ins per CLI bridge. Zero paid APIs — fake CLI shims
// (shell scripts in temp bin dirs), fake child processes, and temp
// config dirs only. Temp usage is a handful of tiny files per test.

import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIDGE_ISOLATION,
  BridgeAccountStore,
  bridgeAccountCredentialsPath,
  bridgeAccountSignedIn,
  bridgeAccountSpawnEnv,
  findHealthySiblingAccount,
  machineDefaultAccount,
  managedAccountConfigDir,
  resolveBridgeAccount,
  resolveBridgeAccountId,
  validateBridgeAccount,
  type BridgeAccount,
} from '../src/providers/bridge-accounts.js';
import { BridgeCooldownRegistry } from '../src/providers/cli-cooldown.js';
import { CliAuthManager, type SpawnHandle } from '../src/providers/cli-auth.js';
import { resetCliIdentityCache } from '../src/providers/cli-bridge.js';
import { NativeCliDriver } from '../src/providers/cli-driver.js';
import { decideBridgeSwap, TRANSCRIPT_REPLAY_MARKER } from '../src/providers/cli-swap.js';
import { setBridgeAccountStore } from '../src/providers/bridge-accounts.js';
import { probeBridgeUsage, resetBridgeUsageCache } from '../src/providers/cli-usage.js';
import { AgentRuntime } from '../src/runtime.js';
import { ProviderSelectionRefusedError } from '../src/failover.js';
import type { GovernanceDecision, GovernanceGateway } from '../src/governance.js';
import type { BotConfig, ChatMessage, LLMProvider, ModelInfo, StreamEvent, TokenUsage, ToolDefinition } from '../src/types.js';

const cleanups: string[] = [];
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}
afterEach(() => {
  resetBridgeUsageCache();
  resetCliIdentityCache();
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function account(partial: Partial<BridgeAccount> & { id: string }): BridgeAccount {
  return {
    bridgeId: 'claude',
    label: partial.id,
    machineDefault: false,
    createdByUs: true,
    ...partial,
  } as BridgeAccount;
}

const bot = (partial: Partial<BotConfig>): BotConfig =>
  ({ id: 'b1', name: 'B', description: '', systemPrompt: '', provider: 'claude-subscription', model: 'sonnet', skills: [], tools: [], mcpServers: [], ...partial }) as BotConfig;

// ---------------------------------------------------------------------------

describe('per-CLI isolation knobs (investigated, declared as data)', () => {
  it('all three bridges declare their real isolation knobs', () => {
    expect(BRIDGE_ISOLATION.claude.isolatable).toBe(true);
    expect(BRIDGE_ISOLATION.claude.envKnobs).toEqual(['CLAUDE_CONFIG_DIR']);
    expect(BRIDGE_ISOLATION.codex.isolatable).toBe(true);
    expect(BRIDGE_ISOLATION.codex.envKnobs).toEqual(['CODEX_HOME']);
    expect(BRIDGE_ISOLATION.opencode.isolatable).toBe(true);
    expect(BRIDGE_ISOLATION.opencode.envKnobs).toContain('XDG_DATA_HOME');
    // The honest gap is documented in the note: OPENCODE_CONFIG_DIR
    // alone does NOT move the login; XDG_DATA_HOME does.
    expect(BRIDGE_ISOLATION.opencode.note).toMatch(/NOT the login/);
  });

  it('spawn env per bridge: default is empty (zero change), accounts carry their dir', () => {
    expect(bridgeAccountSpawnEnv(machineDefaultAccount('claude'))).toEqual({});
    expect(bridgeAccountSpawnEnv(machineDefaultAccount('codex'))).toEqual({});
    expect(bridgeAccountSpawnEnv(machineDefaultAccount('opencode'))).toEqual({});
    expect(bridgeAccountSpawnEnv(account({ id: 'work', configDir: '/a/claude-work' }))).toEqual({
      CLAUDE_CONFIG_DIR: '/a/claude-work',
    });
    expect(
      bridgeAccountSpawnEnv(account({ id: 'work', bridgeId: 'codex', configDir: '/a/codex-work' })),
    ).toEqual({ CODEX_HOME: '/a/codex-work' });
    const oc = bridgeAccountSpawnEnv(account({ id: 'work', bridgeId: 'opencode', configDir: '/a/oc-work' }));
    expect(oc.XDG_DATA_HOME).toBe(join('/a/oc-work', 'data'));
    expect(oc.XDG_CONFIG_HOME).toBe(join('/a/oc-work', 'config'));
    expect(oc.OPENCODE_CONFIG_DIR).toBe(join('/a/oc-work', 'config', 'opencode'));
  });

  it('credential paths follow each CLI layout (default vs account)', () => {
    const home = '/home/tester';
    expect(bridgeAccountCredentialsPath(machineDefaultAccount('claude'), home)).toBe(
      join(home, '.claude', '.credentials.json'),
    );
    expect(bridgeAccountCredentialsPath(machineDefaultAccount('codex'), home)).toBe(join(home, '.codex', 'auth.json'));
    expect(bridgeAccountCredentialsPath(machineDefaultAccount('opencode'), home)).toBe(
      join(home, '.local', 'share', 'opencode', 'auth.json'),
    );
    expect(bridgeAccountCredentialsPath(account({ id: 'w', configDir: '/a/c' }), home)).toBe(join('/a/c', '.credentials.json'));
    expect(bridgeAccountCredentialsPath(account({ id: 'w', bridgeId: 'codex', configDir: '/a/x' }), home)).toBe(join('/a/x', 'auth.json'));
    expect(bridgeAccountCredentialsPath(account({ id: 'w', bridgeId: 'opencode', configDir: '/a/o' }), home)).toBe(
      join('/a/o', 'data', 'opencode', 'auth.json'),
    );
  });
});

describe('store: CRUD, defaults, removal semantics', () => {
  it('machine default is always listed first and can never be removed or renamed', () => {
    const store = new BridgeAccountStore();
    store.upsert(account({ id: 'work', label: 'Work', configDir: '/a/work' }));
    const list = store.list('claude');
    expect(list.map((a) => a.id)).toEqual(['default', 'work']);
    expect(() => store.remove('claude', 'default')).toThrow(/cannot be removed/);
    expect(() => store.rename('claude', 'default', 'X')).toThrow(/cannot be renamed/);
    expect(() => store.upsert(machineDefaultAccount('claude'))).toThrow(/cannot be stored/);
  });

  it('rename + user default + remove clears a dangling user default', () => {
    const store = new BridgeAccountStore();
    store.upsert(account({ id: 'work', label: 'Work', configDir: '/a/work' }));
    expect(store.rename('claude', 'work', 'Work login').label).toBe('Work login');
    store.setUserDefault('claude', 'work');
    expect(store.userDefaultId('claude')).toBe('work');
    const removed = store.remove('claude', 'work');
    expect(removed.id).toBe('work');
    expect(store.userDefaultId('claude')).toBeUndefined();
    expect(store.list('claude').map((a) => a.id)).toEqual(['default']);
  });

  it('validate: slug ids, default id refused, managed-root marks createdByUs', () => {
    const root = '/data/bridge-accounts';
    const inside = validateBridgeAccount(
      { id: 'work', bridgeId: 'claude', label: 'Work', configDir: managedAccountConfigDir('/data', 'claude', 'work') },
      { managedRoot: root },
    );
    expect(inside.createdByUs).toBe(true);
    const outside = validateBridgeAccount(
      { id: 'ext', bridgeId: 'claude', label: 'Ext', configDir: '/elsewhere/ext' },
      { managedRoot: root },
    );
    expect(outside.createdByUs).toBe(false);
    expect(() =>
      validateBridgeAccount({ id: 'default', bridgeId: 'claude', label: 'D', configDir: '/a' }, {}),
    ).toThrow(/built in/);
    expect(() =>
      validateBridgeAccount({ id: 'Bad Id', bridgeId: 'claude', label: 'D', configDir: '/a' }, {}),
    ).toThrow(/invalid account id/);
  });

  it('serialize round-trips accounts + user defaults', () => {
    const store = new BridgeAccountStore();
    store.upsert(account({ id: 'work', label: 'Work', configDir: '/a/work' }));
    store.setUserDefault('codex', 'default'); // clearing semantics: no entry stored
    store.setUserDefault('claude', 'work');
    const back = new BridgeAccountStore(store.serialize());
    expect(back.list('claude').map((a) => a.id)).toEqual(['default', 'work']);
    expect(back.userDefaultId('claude')).toBe('work');
  });
});

describe('selection precedence: bot pick → user default → machine default', () => {
  const store = new BridgeAccountStore({
    accounts: [
      account({ id: 'work', label: 'Work', configDir: '/a/work' }),
      account({ id: 'play', label: 'Play', configDir: '/a/play' }),
    ],
    userDefaults: { claude: 'play' },
  });

  it('bot pick wins over the user default', () => {
    expect(resolveBridgeAccountId(bot({ bridgeAccounts: { claude: 'work' } }), 'claude', store)).toBe('work');
  });
  it('user default wins over machine default', () => {
    expect(resolveBridgeAccountId(bot({}), 'claude', store)).toBe('play');
  });
  it('machine default when nothing is picked', () => {
    expect(resolveBridgeAccountId(bot({}), 'codex', store)).toBe('default');
  });
  it('legacy accountProfile honoured for claude only', () => {
    expect(resolveBridgeAccountId(bot({ accountProfile: 'work' }), 'claude', store)).toBe('work');
    expect(resolveBridgeAccountId(bot({ accountProfile: 'work' }), 'codex', store)).toBe('default');
  });
  it('an unknown bot pick falls DOWN the chain instead of failing', () => {
    expect(resolveBridgeAccountId(bot({ bridgeAccounts: { claude: 'gone' } }), 'claude', store)).toBe('play');
    expect(resolveBridgeAccount(bot({ bridgeAccounts: { claude: 'gone' } }), 'claude', store).machineDefault).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Two fake accounts with separate config dirs.
// ---------------------------------------------------------------------------

describe('two fake claude accounts: independent sign-in state', () => {
  it('shape-probes each account against its OWN credential file', () => {
    const root = tempDir('a6-accts-');
    const workDir = join(root, 'work');
    const playDir = join(root, 'play');
    mkdirSync(workDir, { recursive: true });
    mkdirSync(playDir, { recursive: true });
    // Work is signed in; play has no credential file at all.
    writeFileSync(
      join(workDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'fake-work-token' } }),
    );
    const work = account({ id: 'work', configDir: workDir });
    const play = account({ id: 'play', configDir: playDir });
    expect(bridgeAccountSignedIn(work)).toBe(true);
    expect(bridgeAccountSignedIn(play)).toBe(false);
    // Sign play in too — work's state is unaffected, and a garbage file
    // in a third dir does not count as a sign-in.
    writeFileSync(join(playDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-play-token' } }));
    expect(bridgeAccountSignedIn(play)).toBe(true);
    expect(bridgeAccountSignedIn(work)).toBe(true);
    const junkDir = join(root, 'junk');
    mkdirSync(junkDir, { recursive: true });
    writeFileSync(join(junkDir, '.credentials.json'), JSON.stringify({ hello: 'world' }));
    expect(bridgeAccountSignedIn(account({ id: 'junk', configDir: junkDir }))).toBe(false);
    // Credential contents never leak through the public view.
    expect(JSON.stringify(work)).not.toContain('fake-work-token');
  });

  it('CliAuthManager status for an account runs under the account env and reads its file', async () => {
    const root = tempDir('a6-auth-');
    const workDir = join(root, 'work');
    mkdirSync(workDir, { recursive: true });
    const credPath = join(workDir, '.credentials.json');
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: 'fake' } }));
    const seenEnvs: Array<Record<string, string> | undefined> = [];
    const spawnFn = (command: string, args: string[], opts?: { env?: Record<string, string> }): SpawnHandle => {
      seenEnvs.push(opts?.env);
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      child.kill = () => undefined;
      queueMicrotask(() => {
        const inWork = opts?.env?.CLAUDE_CONFIG_DIR === workDir;
        stdout.emit(
          'data',
          Buffer.from(JSON.stringify(inWork ? { loggedIn: true, email: 'work@example.com' } : { loggedIn: false })),
        );
        child.emit('close', 0, null);
      });
      return {
        child: child as unknown as import('node:child_process').ChildProcess,
        stdout: stdout as unknown as NodeJS.ReadableStream,
        stderr: stderr as unknown as NodeJS.ReadableStream,
      };
    };
    const mgr = new CliAuthManager({
      homeDir: root,
      spawnFn,
      resolveCli: () => ({ path: '/fake/claude' }),
    });
    const ctx = { env: { CLAUDE_CONFIG_DIR: workDir }, credentialsPath: credPath };
    const st = await mgr.getStatus('claude', ctx);
    expect(st.signedIn).toBe(true);
    expect(st.accountHint).toBe('work@example.com');
    expect(seenEnvs[0]).toEqual({ CLAUDE_CONFIG_DIR: workDir });
    // The machine default (no ctx) is probed separately and is NOT
    // signed in — the two accounts' states are independent.
    const def = await mgr.getStatus('claude');
    expect(def.signedIn).toBe(false);
  });

  it('startLogin for an account spawns under its env and completes on ITS credential file', async () => {
    const root = tempDir('a6-login-');
    const playDir = join(root, 'play');
    mkdirSync(playDir, { recursive: true });
    const credPath = join(playDir, '.credentials.json');
    let seenEnv: Record<string, string> | undefined;
    const spawnFn = (command: string, args: string[], opts?: { env?: Record<string, string> }): SpawnHandle => {
      seenEnv = opts?.env;
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const stdin = { write: () => true };
      const child = new EventEmitter() as EventEmitter & { kill: () => void };
      child.kill = () => undefined;
      queueMicrotask(() => {
        stdout.emit('data', Buffer.from('Open https://example.com/oauth to sign in\n'));
        // The "user" completes sign-in: the CLI writes the NEW
        // account's credential file (and only that one).
        setTimeout(() => {
          writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: 'fake-play' } }));
        }, 20);
      });
      return {
        child: child as unknown as import('node:child_process').ChildProcess,
        stdin: stdin as unknown as NodeJS.WritableStream,
        stdout: stdout as unknown as NodeJS.ReadableStream,
        stderr: stderr as unknown as NodeJS.ReadableStream,
      };
    };
    const mgr = new CliAuthManager({
      homeDir: root,
      spawnFn,
      resolveCli: () => ({ path: '/fake/claude' }),
      pollIntervalMs: 5,
      loginTimeoutMs: 2000,
      urlTimeoutMs: 1000,
    });
    const login = mgr.startLogin('claude', { env: { CLAUDE_CONFIG_DIR: playDir }, credentialsPath: credPath });
    await expect(login.url).resolves.toContain('https://example.com/oauth');
    await expect(login.done).resolves.toEqual({ ok: true });
    expect(seenEnv).toEqual({ CLAUDE_CONFIG_DIR: playDir });
    // The machine default's credential file was never created/touched.
    expect(bridgeAccountSignedIn(machineDefaultAccount('claude'), root)).toBe(false);
    expect(readFileSync(credPath, 'utf8')).toContain('fake-play');
  });
});

// ---------------------------------------------------------------------------
// Per-account gauge probing (fake CLI shim keyed on the env it sees).
// ---------------------------------------------------------------------------

describe('per-account usage probes', () => {
  it('the probe runs under the account env — two accounts, two gauges', () => {
    const binDir = tempDir('a6-shim-');
    const home = tempDir('a6-home-');
    const workDir = join(home, 'work-config');
    const shim = join(binDir, 'claude');
    writeFileSync(
      shim,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "2.1.0 (Claude Code)"; exit 0; fi',
        `if [ "$1" = "auth" ]; then`,
        `  case "$CLAUDE_CONFIG_DIR" in`,
        `    *work*) echo '{"loggedIn":true,"five_hour":{"utilization":0.66}}' ;;`,
        `    *) echo '{"loggedIn":true,"five_hour":{"utilization":0.10}}' ;;`,
        '  esac',
        '  exit 0',
        'fi',
        'exit 1',
        '',
      ].join('\n'),
    );
    chmodSync(shim, 0o755);
    const detect = { homeDir: home, pathDirs: [binDir] };
    const gDefault = probeBridgeUsage('claude', { detect, fresh: true });
    const gWork = probeBridgeUsage('claude', {
      detect,
      fresh: true,
      accountId: 'work',
      env: { CLAUDE_CONFIG_DIR: workDir },
    });
    expect(gDefault.utilisationPercent).toBe(10);
    expect(gWork.utilisationPercent).toBe(66);
    expect(gWork.accountId).toBe('work');
  });
});

// ---------------------------------------------------------------------------
// Spawn isolation through the native driver.
// ---------------------------------------------------------------------------

describe('native driver spawn env carries the account config dir', () => {
  it('a turn on the work account spawns with CLAUDE_CONFIG_DIR=<work dir>', async () => {
    const lines = [
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done', session_id: 's1' }),
    ];
    const seen: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const spawnFn = (command: string, args: string[], opts: { env?: Record<string, string> }) => {
      seen.push({ args, env: opts.env });
      const emitter = new EventEmitter();
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = Object.assign(emitter, { kill: () => undefined });
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
    };
    const workEnv = bridgeAccountSpawnEnv(account({ id: 'work', configDir: '/a6/work-config' }));
    const driver = new NativeCliDriver({
      cliId: 'claude-code',
      model: 'sonnet',
      command: 'fake-claude',
      spawnFn: spawnFn as never,
      env: workEnv,
      timeoutMs: 5000,
      preflightAuthCheck: () => Promise.resolve(null),
    });
    const result = await driver.chat([{ role: 'user', content: 'hi' }], [], { model: 'sonnet' });
    expect(result.content).toContain('done');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.env?.CLAUDE_CONFIG_DIR).toBe('/a6/work-config');
    // The rest of the process env rides along (merge, not replace).
    expect(seen[0]!.env?.PATH).toBe(process.env.PATH);
  });
});

// ---------------------------------------------------------------------------
// Runtime integration: bot account selection + sibling swap mid-job.
// Scripted in-process providers (zero paid APIs), mirroring the A1
// runtime harness — the TestRuntime records WHICH ACCOUNT each provider
// construction was scoped to, which is the spawn-isolation proof at the
// runtime layer (the env itself is proven at the driver layer above).
// ---------------------------------------------------------------------------

class FakeGateway implements GovernanceGateway {
  async classify(): Promise<GovernanceDecision> { return 'allow'; }
  async evaluate(): Promise<{ decision: GovernanceDecision }> { return { decision: 'allow' }; }
  async awaitDecision(): Promise<'approved' | 'denied'> { return 'approved'; }
  decide(): void {}
  audit(): void {}
  async runPreHooks(): Promise<void> {}
  async runPostHooks(): Promise<void> {}
}

class ScriptedProvider implements LLMProvider {
  readonly calls: Array<{ model: string; messages: ChatMessage[] }> = [];
  constructor(
    readonly providerId: string,
    private readonly behavior: (callIndex: number) => { content: string } | Error,
  ) {}
  async chat(
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    opts: { model: string },
  ): Promise<{ content: string; toolCalls: never[]; usage: TokenUsage }> {
    this.calls.push({ model: opts.model, messages: [...messages] });
    const out = this.behavior(this.calls.length - 1);
    if (out instanceof Error) throw out;
    return { content: out.content, toolCalls: [], usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 } };
  }
  async listModels(): Promise<ModelInfo[]> { return [{ id: 'm', name: 'M' }]; }
}

function quotaError(): Error & { status?: number; code?: string } {
  const e = new Error('Provider request failed: 429 — {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}') as Error & { status?: number; code?: string };
  e.status = 429;
  e.code = 'insufficient_quota';
  return e;
}

function makeRuntime(
  providers: Map<string, LLMProvider>,
  cooldowns: BridgeCooldownRegistry,
  constructions: Array<{ providerId: string; accountId?: string }>,
): AgentRuntime {
  class TestRuntime extends AgentRuntime {
    protected override resolveProvider(providerId: string, botArg?: BotConfig, accountIdOverride?: string): LLMProvider {
      // Record the account the runtime scoped this construction to:
      // the override (sibling swap) or the bot's resolved account.
      const bridge = providerId === 'claude-subscription' ? ('claude' as const) : undefined;
      const accountId = accountIdOverride ?? (bridge && botArg ? resolveBridgeAccountId(botArg, bridge) : undefined);
      constructions.push({ providerId, accountId });
      // Per-account provider instances: a construction scoped to a
      // different account returns that account's scripted provider.
      const p = providers.get(accountId ? `${providerId}#${accountId}` : providerId) ?? providers.get(providerId);
      if (!p) throw new Error(`no test provider "${providerId}"`);
      return p;
    }
  }
  return new TestRuntime({
    dbPath: ':memory:',
    skillsDir: '/tmp/agent-runtime-test-skills-missing',
    governance: new FakeGateway(),
    toolRegistry: new Map(),
    defaultProviderId: 'claude-subscription',
    bridgeCooldowns: cooldowns,
  });
}

describe('runtime: bot account selection honoured + sibling swap', () => {
  it('auto lane: work account quota-dies mid-job → the turn continues on the sibling play account (same provider), cross-provider backup untouched', async () => {
    setBridgeAccountStore(
      new BridgeAccountStore({
        accounts: [
          account({ id: 'work', label: 'Work', configDir: '/a6/work' }),
          account({ id: 'play', label: 'Play', configDir: '/a6/play' }),
        ],
      }),
    );
    const cooldowns = new BridgeCooldownRegistry({});
    // The machine-default account is ALSO a sibling candidate and is
    // listed first — cool it so the named sibling (play) is the healthy
    // candidate this test exercises.
    cooldowns.recordFailure('claude', 'default', new Error('usage limit reached — 100% used, resets at 2999-01-01T00:00:00.000Z'));
    const work = new ScriptedProvider('claude-subscription', () => quotaError());
    const play = new ScriptedProvider('claude-subscription', () => ({ content: 'continued on play account' }));
    const crossBackup = new ScriptedProvider('backup', () => ({ content: 'must not run' }));
    const constructions: Array<{ providerId: string; accountId?: string }> = [];
    const rt = makeRuntime(
      new Map<string, LLMProvider>([
        ['claude-subscription#work', work],
        ['claude-subscription#play', play],
        ['claude-subscription', work],
        ['backup', crossBackup],
      ]),
      cooldowns,
      constructions,
    );
    const botA = bot({
      provider: 'claude-subscription',
      model: 'sonnet',
      backupProvider: 'backup',
      backupModel: 'backup-model',
      bridgeAccounts: { claude: 'work' },
    });
    const events: StreamEvent[] = [];
    await rt.runTurn({ bot: botA, message: 'hello', sessionId: 'a6-sibling', onEvent: (e) => { events.push(e); } });
    // The work account died; the SAME provider completed on play.
    expect(work.calls).toHaveLength(1);
    expect(play.calls).toHaveLength(1);
    expect(crossBackup.calls).toHaveLength(0);
    // The sibling retry received the transcript replay.
    expect(play.calls[0]!.messages.map((m) => m.content).join('\n')).toContain(TRANSCRIPT_REPLAY_MARKER);
    // Constructions were scoped: first to work (bot pick), then to play.
    expect(constructions.map((c) => c.accountId)).toContain('work');
    expect(constructions.map((c) => c.accountId)).toContain('play');
    // Cooldown recorded against WORK only; play stays healthy.
    expect(cooldowns.check('claude', 'work').active).toBe(true);
    expect(cooldowns.check('claude', 'play').active).toBe(false);
    const text = (await rt.sessionStore.getMessages('a6-sibling')).map((m) => m.content).join('\n');
    expect(text).toContain('continued on play account');
    rt.close();
  });

  it('explicit selection: work account quota-dies → loud refusal, sibling NEVER called', async () => {
    setBridgeAccountStore(
      new BridgeAccountStore({
        accounts: [
          account({ id: 'work', label: 'Work', configDir: '/a6/work' }),
          account({ id: 'play', label: 'Play', configDir: '/a6/play' }),
        ],
      }),
    );
    const cooldowns = new BridgeCooldownRegistry({});
    const work = new ScriptedProvider('claude-subscription', () => quotaError());
    const play = new ScriptedProvider('claude-subscription', () => ({ content: 'must not run' }));
    const constructions: Array<{ providerId: string; accountId?: string }> = [];
    const rt = makeRuntime(
      new Map<string, LLMProvider>([
        ['claude-subscription#work', work],
        ['claude-subscription#play', play],
        ['claude-subscription', work],
      ]),
      cooldowns,
      constructions,
    );
    const botA = bot({ provider: 'claude-subscription', model: 'sonnet', bridgeAccounts: { claude: 'work' } });
    const err = await rt
      .runTurn({
        bot: botA,
        message: 'hello',
        sessionId: 'a6-explicit',
        providerId: 'claude-subscription',
        model: 'sonnet',
        explicitSelection: true,
        selectedProviderId: 'claude-subscription',
        selectedModel: 'sonnet',
        onEvent: () => undefined,
      })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderSelectionRefusedError);
    expect(work.calls).toHaveLength(1);
    expect(play.calls).toHaveLength(0);
    rt.close();
  });
});

// ---------------------------------------------------------------------------
// Cooldown isolation + sibling swap candidates.
// ---------------------------------------------------------------------------

describe('cooldown isolation between accounts of one bridge', () => {
  it('cooling account A does not block sibling B; the sibling finder sees B as healthy', () => {
    const registry = new BridgeCooldownRegistry({});
    registry.recordFailure('claude', 'work', new Error('usage limit reached — 100% used, resets at 2999-01-01T00:00:00.000Z'));
    expect(registry.check('claude', 'work').active).toBe(true);
    expect(registry.check('claude', 'play').active).toBe(false);
    expect(registry.check('claude', 'default').active).toBe(false);
    const store = new BridgeAccountStore({
      accounts: [
        account({ id: 'work', configDir: '/a/work' }),
        account({ id: 'play', configDir: '/a/play' }),
      ],
    });
    const sibling = findHealthySiblingAccount(store, registry, 'claude', 'work');
    expect(sibling?.id).toBe('default'); // machine default listed first, and healthy
    // Cool the default too → the next sibling is 'play'.
    registry.recordFailure('claude', 'default', new Error('usage limit reached — 100% used, resets at 2999-01-01T00:00:00.000Z'));
    expect(findHealthySiblingAccount(store, registry, 'claude', 'work')?.id).toBe('play');
    // Cool everything → no sibling candidate.
    registry.recordFailure('claude', 'play', new Error('usage limit reached — 100% used, resets at 2999-01-01T00:00:00.000Z'));
    expect(findHealthySiblingAccount(store, registry, 'claude', 'work')).toBeUndefined();
  });

  it('decideBridgeSwap: sibling swap on the AUTO lane only — explicit selections refuse as before (unit)', () => {
    const base = {
      quotaDeath: true,
      driverFailure: false,
      failedProviderId: 'claude-subscription',
      failedModelId: 'sonnet',
      failedReason: 'usage limit',
      declaredBackup: null,
      autoTarget: { providerId: 'codex-subscription', modelId: 'gpt-5' },
      autoTargetCooldownReason: null,
      siblingAccount: { accountId: 'play' },
    };
    const auto = decideBridgeSwap({ ...base, explicitSelection: false });
    expect(auto.action).toBe('swap');
    if (auto.action === 'swap') {
      expect(auto.via).toBe('sibling-account');
      expect(auto.target.providerId).toBe('claude-subscription');
      expect(auto.target.modelId).toBe('sonnet');
      expect(auto.target.accountId).toBe('play');
    }
    // Explicit selection: the sibling is NOT a candidate; with no
    // declared backup the decision is the v0.2.2 loud refusal.
    const explicit = decideBridgeSwap({ ...base, explicitSelection: true });
    expect(explicit.action).toBe('refuse');
    // Auto lane with no sibling keeps the A1 cross-provider behaviour.
    const noSibling = decideBridgeSwap({ ...base, explicitSelection: false, siblingAccount: null });
    expect(noSibling.action).toBe('swap');
    if (noSibling.action === 'swap') {
      expect(noSibling.via).toBe('auto');
      expect(noSibling.target.providerId).toBe('codex-subscription');
    }
  });
});
