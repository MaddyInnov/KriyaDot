// SPDX-License-Identifier: Apache-2.0
// Phase A (A-7 + A-8): per-account spawn env on the two lanes A6/A2
// left un-wired.
//
// A-7 — OpenCode ACP lane (`agent/opencode/<model>`): the ACP protocol
// has no per-turn env channel and CopilotAcpProvider keeps ONE
// long-lived ACP process per provider instance, so the account env is
// a spawn-time property carried by the constructor (factory passes
// createProvider's opts.env; the runtime resolves + caches one
// provider instance per account). These tests pin that the env
// actually reaches the spawned ACP process, that B-1's consent +
// verified-executable requirements still gate the lane, and that a
// machine-default construction injects no override.
//
// A-8 — Pi chat lane (one-shot AgentCliProvider): a non-default Pi
// account's PI_CODING_AGENT_DIR must reach the one-shot spawn (preset
// lane `pi-subscription` AND the `agent/pi/…` lane), and the
// machine-default spawn must inherit the process env untouched.
//
// All binaries are fake shims in temp dirs; zero real CLIs, zero paid
// APIs. /tmp scratch only.

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProvider } from '../src/providers/factory.js';
import { AgentCliProvider, createAgentCliProvider } from '../src/providers/agent-cli.js';
import { createAcpEngineProvider, type AcpEngineClient } from '../src/providers/acp-engines.js';
import {
  bridgeAccountSpawnEnv,
  type BridgeAccount,
} from '../src/providers/bridge-accounts.js';
import {
  grantBridgeConsent,
  resetBridgeConsent,
  resetCliIdentityCache,
} from '../src/providers/cli-bridge.js';

let binDir = '';
let savedPath = '';
const savedEnv: Record<string, string | undefined> = {};

const ENV_KEYS = ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'PI_CODING_AGENT_DIR'];

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'a7a8-bin-'));
  savedPath = process.env.PATH ?? '';
  process.env.PATH = [binDir, savedPath].join(delimiter);
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  resetCliIdentityCache();
  resetBridgeConsent();
});

afterEach(() => {
  process.env.PATH = savedPath;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetCliIdentityCache();
  resetBridgeConsent();
});

function plant(name: string, body: string): string {
  const p = join(binDir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

function account(partial: Partial<BridgeAccount> & { bridgeId: BridgeAccount['bridgeId'] }): BridgeAccount {
  return {
    id: 'work',
    label: 'Work',
    machineDefault: false,
    createdByUs: false,
    ...partial,
  } as BridgeAccount;
}

const ocAccount = account({ bridgeId: 'opencode', configDir: '/acct/oc-work' });
const ocEnv = bridgeAccountSpawnEnv(ocAccount);

// ---------------------------------------------------------------------------
// A-8: Pi one-shot lane
// ---------------------------------------------------------------------------

/**
 * Fake Pi: --version prints a bare semver and --help prints the real
 * binary's recorded banner line — Pi's identity probe (B-3) requires
 * BOTH signals, since the bare semver alone is content-free. A turn
 * echoes the agent dir it was spawned under.
 */
function plantPi(): string {
  return plant(
    'pi',
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "1.6.1"; exit 0; fi',
      'if [ "$1" = "--help" ]; then echo "pi - AI coding assistant with read, bash, edit, write tools"; exit 0; fi',
      'echo "PI_DIR=${PI_CODING_AGENT_DIR:-unset}"',
      'exit 0',
      '',
    ].join('\n'),
  );
}

describe('A-8: Pi one-shot provider spawn env', () => {
  it('AgentCliProvider spawns with PI_CODING_AGENT_DIR for a non-default account', async () => {
    const exe = plantPi();
    const provider = new AgentCliProvider({
      cliId: 'pi',
      model: 'default',
      command: exe,
      env: { PI_CODING_AGENT_DIR: '/acct/pi-work' },
    });
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'default' });
    expect(res.content).toContain('PI_DIR=/acct/pi-work');
  });

  it('AgentCliProvider with NO env inherits the process env untouched (machine default)', async () => {
    const exe = plantPi();
    process.env.PI_CODING_AGENT_DIR = '/machine/pi-agent';
    const provider = new AgentCliProvider({ cliId: 'pi', model: 'default', command: exe });
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'default' });
    expect(res.content).toContain('PI_DIR=/machine/pi-agent');
    // An explicitly EMPTY env (the machine-default account's spawn env)
    // is identical: no override is injected.
    const empty = createAgentCliProvider('agent/pi/default', { command: exe, env: {} });
    const res2 = await empty.chat([{ role: 'user', content: 'hi' }], [], { model: 'default' });
    expect(res2.content).toContain('PI_DIR=/machine/pi-agent');
  });

  it('factory preset lane (pi-subscription) applies the account env to the spawn', async () => {
    plantPi();
    grantBridgeConsent('pi');
    const env = bridgeAccountSpawnEnv(account({ bridgeId: 'pi', configDir: '/acct/pi-work' }));
    expect(env).toEqual({ PI_CODING_AGENT_DIR: '/acct/pi-work' });
    const provider = createProvider('pi-subscription', { env });
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'default' });
    expect(res.content).toContain('PI_DIR=/acct/pi-work');
  });

  it('factory preset lane with NO env leaves the spawn inheriting the process env', async () => {
    plantPi();
    grantBridgeConsent('pi');
    process.env.PI_CODING_AGENT_DIR = '/machine/pi-agent';
    const provider = createProvider('pi-subscription');
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'default' });
    expect(res.content).toContain('PI_DIR=/machine/pi-agent');
  });

  it('factory agent lane (agent/pi/default) applies the account env to the spawn', async () => {
    plantPi();
    grantBridgeConsent('pi');
    const provider = createProvider('agent/pi/default', {
      env: { PI_CODING_AGENT_DIR: '/acct/pi-work' },
    });
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'default' });
    expect(res.content).toContain('PI_DIR=/acct/pi-work');
  });
});

// ---------------------------------------------------------------------------
// A-7: OpenCode ACP lane
// ---------------------------------------------------------------------------

/**
 * Fake OpenCode: --version prints a bare semver (identity); ACP mode
 * (`opencode acp`) speaks the minimal JSON-RPC loop and answers prompts
 * with the XDG env it was spawned under.
 */
function plantOpenCode(): string {
  const body = `#!/usr/bin/env node
if (process.argv[2] === '--version') { console.log('1.0.0'); process.exit(0); }
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-opencode' } } }) + '\\n');
  } else if (msg.method === 'prompt') {
    const text = 'XDG_DATA_HOME=' + (process.env.XDG_DATA_HOME || 'unset') + ' OPENCODE_CONFIG_DIR=' + (process.env.OPENCODE_CONFIG_DIR || 'unset');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { text } }) + '\\n');
  }
});
`;
  return plant('opencode', body);
}

describe('A-7: OpenCode ACP lane account env', () => {
  it('an opencode ACP turn for a non-default account spawns with the account XDG env', async () => {
    plantOpenCode();
    grantBridgeConsent('opencode');
    expect(ocEnv.XDG_DATA_HOME).toBe('/acct/oc-work/data');
    const provider = createProvider('agent/opencode/default', { env: ocEnv });
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'default' });
    expect(res.content).toContain('XDG_DATA_HOME=/acct/oc-work/data');
    expect(res.content).toContain('OPENCODE_CONFIG_DIR=/acct/oc-work/config/opencode');
    (provider as unknown as { close(): void }).close();
  });

  it('a machine-default opencode ACP turn injects NO env override', async () => {
    plantOpenCode();
    grantBridgeConsent('opencode');
    const provider = createProvider('agent/opencode/default');
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'default' });
    expect(res.content).toContain('XDG_DATA_HOME=unset');
    expect(res.content).toContain('OPENCODE_CONFIG_DIR=unset');
    (provider as unknown as { close(): void }).close();
  });

  it('B-1 intact: the lane still refuses without Connect consent', () => {
    plantOpenCode();
    expect(() => createProvider('agent/opencode/default', { env: ocEnv })).toThrow(/not connected/i);
  });

  it('B-1 intact: a namesake opencode binary is refused even with consent + env', () => {
    plant('opencode', '#!/bin/sh\necho "banana-tool 9.9.9"\nexit 0\n');
    grantBridgeConsent('opencode');
    expect(() => createProvider('agent/opencode/default', { env: ocEnv })).toThrow();
  });

  it('provider lifecycle: env is spawn-time, one process per instance (createClient seam)', async () => {
    const seen: Array<{ env?: Record<string, string> }> = [];
    let clients = 0;
    const provider = createAcpEngineProvider('agent/opencode/default', {
      command: '/verified/opencode',
      env: ocEnv,
      createClient: (o) => {
        clients += 1;
        seen.push({ env: o.env });
        const client: AcpEngineClient = {
          connect: async () => ({ agentName: 'fake-opencode' }),
          promptStream: async () => ({ text: 'ok' }),
          isConnected: () => true,
          close: () => undefined,
        };
        return client;
      },
    });
    expect(provider).not.toBeNull();
    await provider!.chat([{ role: 'user', content: 'one' }], [], { model: 'default' });
    await provider!.chat([{ role: 'user', content: 'two' }], [], { model: 'default' });
    // Two turns, ONE spawn: the env cannot change mid-instance — a
    // different account is a different provider instance by design.
    expect(clients).toBe(1);
    expect(seen[0]!.env).toMatchObject({
      XDG_DATA_HOME: '/acct/oc-work/data',
      XDG_CONFIG_HOME: '/acct/oc-work/config',
      OPENCODE_CONFIG_DIR: '/acct/oc-work/config/opencode',
    });
    provider!.close();
  });
});
