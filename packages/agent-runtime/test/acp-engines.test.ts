// SPDX-License-Identifier: Apache-2.0
// GitHub Copilot CLI as a built-in ACP engine (W9 engines pack):
// - preset registration + spawn-args construction
// - CLI auto-detection entry (agent registry is data-driven; copilot is in it)
// - ACP session creation against a MOCK ACP stdio process via the preset
// - CopilotAcpProvider chat against the mock process (zero real Copilot use)
// - factory routing for agent/copilot/<model>
// - BotConfig.acp.engine resolution through acpOptionsFromBot
// - cli-auth sign-in status for copilot (GitHub login shape; no OAuth, no
//   token bytes ever returned)

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acpEngineSessionOptions,
  acpOptionsFromBot,
  buildAcpEngineArgs,
  CopilotAcpProvider,
  createAcpEngineSession,
  createCopilotAcpProvider,
  detectAcpEngines,
  getAcpEnginePreset,
  isAcpEngineId,
  listAcpEnginePresets,
  loadAgentRegistry,
  AcpSessionManager,
  AcpSessionStore,
} from '../src/index.js';
import { CliAuthManager } from '../src/providers/cli-auth.js';
import { createProvider } from '../src/providers/factory.js';

/** Mock ACP agent speaking the minimal protocol over stdio (same shape as acp.test.ts). */
const MOCK_AGENT = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'mock-copilot' } } }) + '\\n');
  } else if (msg.method === 'prompt') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { text: 'mock copilot reply' } }) + '\\n');
  }
});
`;

const managers: AcpSessionManager[] = [];
const stores: AcpSessionStore[] = [];

function makeManager(): { manager: AcpSessionManager; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'acp-engines-test-'));
  const store = new AcpSessionStore(dir);
  const manager = new AcpSessionManager(store);
  managers.push(manager);
  stores.push(store);
  return { manager, dir };
}

afterEach(() => {
  for (const m of managers.splice(0)) m.closeAll();
  for (const s of stores.splice(0)) s.close();
});

describe('copilot ACP engine preset', () => {
  it('is registered with the copilot binary and --acp spawn args', () => {
    const preset = getAcpEnginePreset('copilot');
    expect(preset).toBeDefined();
    expect(preset?.name).toBe('GitHub Copilot CLI');
    expect(preset?.command).toBe('copilot');
    expect(buildAcpEngineArgs(preset!)).toEqual(['--acp']);
    expect(preset?.authId).toBe('copilot');
    expect(preset?.models.length).toBeGreaterThan(0);
    expect(isAcpEngineId('copilot')).toBe(true);
    expect(isAcpEngineId('nope')).toBe(false);
    expect(listAcpEnginePresets().map((p) => p.id)).toContain('copilot');
  });

  it('builds session options from the preset', () => {
    const opts = acpEngineSessionOptions('copilot', { cwd: '/tmp/ws' });
    expect(opts.command).toBe('copilot');
    expect(opts.args).toEqual(['--acp']);
    expect(opts.cwd).toBe('/tmp/ws');
    expect(opts.label).toBe('GitHub Copilot CLI');
    expect(() => acpEngineSessionOptions('nope', { cwd: '/tmp' })).toThrow(/Unknown ACP engine/);
  });

  it('is present in the data-driven CLI auto-detection registry', () => {
    const entry = loadAgentRegistry().find((e) => e.id === 'copilot');
    expect(entry).toBeDefined();
    expect(entry?.bins).toContain('copilot');
    expect(entry?.acpCompatible).toBe(true);
    const detection = detectAcpEngines().find((d) => d.id === 'copilot');
    expect(detection).toBeDefined();
    expect(detection?.command).toBe('copilot');
    expect(typeof detection?.installed).toBe('boolean');
  });
});

describe('copilot ACP session against a mock ACP stdio process', () => {
  it('creates a session through the preset with mock command/args overrides', async () => {
    const { manager } = makeManager();
    const session = await createAcpEngineSession(manager, 'copilot', {
      cwd: process.cwd(),
      command: 'node',
      args: ['-e', MOCK_AGENT],
    });
    expect(session.agentName).toBe('mock-copilot');
    expect(session.command).toBe('node');
    const reply = await manager.prompt(session.id, 'hello copilot');
    expect(reply).toBe('mock copilot reply');
  });

  it('spawns a fake `copilot` binary from PATH with the preset args', async () => {
    const binDir = mkdtempSync(join(tmpdir(), 'fake-copilot-bin-'));
    const script = `#!/usr/bin/env node\n${MOCK_AGENT}`;
    const binPath = join(binDir, 'copilot');
    writeFileSync(binPath, script);
    chmodSync(binPath, 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${savedPath ?? ''}`;
    try {
      const { manager } = makeManager();
      // No overrides: the preset's own command + args must do the spawn.
      const session = await createAcpEngineSession(manager, 'copilot', { cwd: process.cwd() });
      expect(session.agentName).toBe('mock-copilot');
      expect(session.command).toBe('copilot');
      expect(session.args).toEqual(['--acp']);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });
});

describe('CopilotAcpProvider', () => {
  it('chats through a mock ACP process and marks output untrusted', async () => {
    const provider = new CopilotAcpProvider({
      model: 'default',
      cwd: process.cwd(),
      command: 'node',
      args: ['-e', MOCK_AGENT],
    });
    try {
      const tokens: string[] = [];
      const result = await provider.chat([{ role: 'user', content: 'hi' }], [], {
        model: 'default',
        onToken: (t) => tokens.push(t),
      });
      expect(result.content).toContain('mock copilot reply');
      expect(result.content).toContain('untrusted');
      expect(result.toolCalls).toEqual([]);
      expect(provider.providerId).toBe('agent/copilot/default');
      const models = await provider.listModels();
      expect(models.map((m) => m.id)).toContain('default');
    } finally {
      provider.close();
    }
  });

  it('createCopilotAcpProvider parses ids and ignores other CLIs', () => {
    const p = createCopilotAcpProvider('agent/copilot/gpt-5', { cwd: process.cwd() });
    expect(p).toBeInstanceOf(CopilotAcpProvider);
    expect(p?.providerId).toBe('agent/copilot/gpt-5');
    p?.close();
    expect(createCopilotAcpProvider('agent/codex/gpt-5')).toBeNull();
    expect(createCopilotAcpProvider('groq')).toBeNull();
  });

  it('factory routes agent/copilot/<model> to the ACP provider', () => {
    const provider = createProvider('agent/copilot/default');
    expect(provider).toBeInstanceOf(CopilotAcpProvider);
    (provider as CopilotAcpProvider).close();
  });
});

describe('bot ACP engine config', () => {
  it('acpOptionsFromBot resolves { engine: "copilot" } to the preset command/args', () => {
    const opts = acpOptionsFromBot({ acp: { engine: 'copilot' } });
    expect(opts).toEqual({ command: 'copilot', args: ['--acp'] });
  });

  it('explicit bot command/args still win over the preset', () => {
    const opts = acpOptionsFromBot({ acp: { engine: 'copilot', command: 'my-copilot', args: ['--acp', '--stdio'] } });
    expect(opts).toEqual({ command: 'my-copilot', args: ['--acp', '--stdio'] });
    expect(acpOptionsFromBot({ acp: { command: 'opencode', args: ['acp'] } })).toEqual({
      command: 'opencode',
      args: ['acp'],
    });
    expect(acpOptionsFromBot({})).toBeNull();
    expect(acpOptionsFromBot(undefined)).toBeNull();
  });
});

describe('copilot sign-in status (cli-auth)', () => {
  function managerFor(home: string): CliAuthManager {
    return new CliAuthManager({
      homeDir: home,
      pathDirs: [],
      fileExists: (p) => {
        try {
          return existsSync(p);
        } catch {
          return false;
        }
      },
      readText: (p) => {
        try {
          return readFileSync(p, 'utf8');
        } catch {
          return undefined;
        }
      },
    });
  }

  it('reports signed-out when no GitHub hosts file exists', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copilot-auth-'));
    const status = await managerFor(home).getStatus('copilot');
    expect(status.cliId).toBe('copilot');
    expect(status.credentialsPresent).toBe(false);
    expect(status.signedIn).toBe(false);
  });

  it('reports signed-in from the gh hosts.yml shape and surfaces only the username', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copilot-auth-'));
    const ghDir = join(home, '.config', 'gh');
    mkdirSync(ghDir, { recursive: true });
    writeFileSync(
      join(ghDir, 'hosts.yml'),
      'github.com:\n    oauth_token: gho_SECRETTOKENVALUE123\n    user: octocat\n    git_protocol: https\n',
    );
    const status = await managerFor(home).getStatus('copilot');
    expect(status.credentialsPresent).toBe(true);
    expect(status.signedIn).toBe(true);
    expect(status.accountHint).toBe('octocat');
    // The token value must never leak into the status object.
    expect(JSON.stringify(status)).not.toContain('gho_SECRETTOKENVALUE123');
  });

  it('treats an empty hosts.yml as signed-out', async () => {
    const home = mkdtempSync(join(tmpdir(), 'copilot-auth-'));
    const ghDir = join(home, '.config', 'gh');
    mkdirSync(ghDir, { recursive: true });
    writeFileSync(join(ghDir, 'hosts.yml'), 'github.com: {}\n');
    const status = await managerFor(home).getStatus('copilot');
    expect(status.credentialsPresent).toBe(true);
    expect(status.signedIn).toBe(false);
  });
});
