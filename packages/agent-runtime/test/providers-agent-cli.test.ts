// SPDX-License-Identifier: Apache-2.0
// Agent-CLI-as-inference-backend: id parsing, detection, spec registry, and
// the provider itself against a mock CLI script (no network, no real CLIs).

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentCliProvider,
  createAgentCliProvider,
  detectAgentClis,
  flattenMessagesForCli,
  getAgentCliSpec,
  listAgentCliSpecs,
  parseAgentProviderId,
  registerAgentCliSpec,
  untrustedCliPrefix,
} from '../src/providers/agent-cli.js';
import { createProvider } from '../src/providers/factory.js';

describe('parseAgentProviderId', () => {
  it('parses agent/<cli-id>/<model>', () => {
    expect(parseAgentProviderId('agent/claude-code/sonnet')).toEqual({
      cliId: 'claude-code',
      model: 'sonnet',
    });
  });

  it('keeps slashes inside the model part', () => {
    expect(parseAgentProviderId('agent/codex/openai/gpt-5')).toEqual({
      cliId: 'codex',
      model: 'openai/gpt-5',
    });
  });

  it('rejects non-agent ids and malformed shapes', () => {
    expect(parseAgentProviderId('groq/gpt-oss-20b')).toBeNull();
    expect(parseAgentProviderId('agent')).toBeNull();
    expect(parseAgentProviderId('agent/')).toBeNull();
    expect(parseAgentProviderId('agent/claude-code')).toBeNull();
    expect(parseAgentProviderId('agent//model')).toBeNull();
  });
});

describe('spec registry', () => {
  it('ships the four known CLIs with shell-free argv builders', () => {
    const ids = listAgentCliSpecs().map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['claude-code', 'codex', 'gemini', 'pi']));
    const claude = getAgentCliSpec('claude-code')!;
    const args = claude.buildArgs('sonnet', 'hello "world" $(rm -rf /)');
    // Prompt travels as one argv element — no shell, no interpolation.
    expect(args).toContain('hello "world" $(rm -rf /)');
    expect(args[0]).toBe('-p');
  });

  it('registerAgentCliSpec overrides / adds specs', () => {
    registerAgentCliSpec({
      id: 'test-override',
      command: 'test-override-cmd',
      buildArgs: (model, prompt) => [model, prompt],
      notes: 'test',
    });
    expect(getAgentCliSpec('test-override')!.command).toBe('test-override-cmd');
  });
});

describe('detectAgentClis', () => {
  it('finds an executable on a synthetic PATH, pure lookup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kriyadot-cli-detect-'));
    const exe = join(dir, 'claude');
    writeFileSync(exe, '#!/bin/sh\necho hi\n');
    chmodSync(exe, 0o755);
    const found = detectAgentClis([dir]).filter((d) => d.id === 'claude-code');
    expect(found).toHaveLength(1);
    expect(found[0]!.installed).toBe(true);
    expect(found[0]!.command).toBe('claude');
    const missing = detectAgentClis([join(tmpdir(), 'kriyadot-nope')]).filter(
      (d) => d.id === 'claude-code',
    );
    expect(missing[0]!.installed).toBe(false);
  });
});

describe('flattenMessagesForCli', () => {
  it('flattens roles into plain text', () => {
    const text = flattenMessagesForCli([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    expect(text).toContain('system: be nice');
    expect(text).toContain('user: hi');
    expect(text).toContain('assistant: hello');
  });
});

/** A mock agent CLI: echoes its argv as JSON, exits 0. */
function writeMockCli(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kriyadot-mock-cli-'));
  const path = join(dir, 'mock-agent-cli');
  writeFileSync(
    path,
    '#!/bin/sh\nprintf \'{"argv":%s}\' "$(printf "%s" "$*" | sed \'s/"/\\\\"/g\')" | head -c 4000; printf \'\nmock cli response text\'\n',
  );
  chmodSync(path, 0o755);
  return path;
}

function writeFailingCli(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kriyadot-mock-cli-'));
  const path = join(dir, 'mock-agent-cli-fail');
  writeFileSync(path, '#!/bin/sh\necho "boom: bad flags" >&2\nexit 3\n');
  chmodSync(path, 0o755);
  return path;
}

describe('AgentCliProvider', () => {
  it('spawns the CLI shell-free and marks output untrusted', async () => {
    const provider = new AgentCliProvider({
      cliId: 'claude-code',
      model: 'sonnet',
      command: writeMockCli(),
      timeoutMs: 10_000,
    });
    expect(provider.providerId).toBe('agent/claude-code/sonnet');
    const res = await provider.chat(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'answer me' },
      ],
      [],
      { model: 'sonnet' },
    );
    expect(res.content.startsWith(untrustedCliPrefix('claude-code'))).toBe(true);
    expect(res.content).toContain('mock cli response text');
    // The prompt reached the child as argv (visible in the echoed args).
    expect(res.content).toContain('answer me');
    expect(res.toolCalls).toEqual([]);
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    const models = await provider.listModels();
    expect(models[0]!.id).toBe('sonnet');
  });

  it('streams through onToken like other providers', async () => {
    const provider = new AgentCliProvider({
      cliId: 'codex',
      model: 'gpt-5',
      command: writeMockCli(),
      timeoutMs: 10_000,
    });
    const tokens: string[] = [];
    const res = await provider.chat([{ role: 'user', content: 'hi' }], [], {
      model: 'gpt-5',
      onToken: (t) => tokens.push(t),
    });
    expect(tokens.join('')).toBe(res.content);
  });

  it('throws a clear error when the CLI fails', async () => {
    const provider = new AgentCliProvider({
      cliId: 'gemini',
      model: 'x',
      command: writeFailingCli(),
      timeoutMs: 10_000,
    });
    await expect(provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'x' })).rejects.toThrow(
      /exited with code 3/,
    );
  });

  it('throws a clear error when the executable is missing', async () => {
    const provider = new AgentCliProvider({
      cliId: 'pi',
      model: 'x',
      command: '/nonexistent/kriyadot-cli-missing',
      timeoutMs: 10_000,
    });
    await expect(provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'x' })).rejects.toThrow(
      /failed to start/,
    );
  });
});

describe('createAgentCliProvider', () => {
  it('rejects malformed ids with the expected format', () => {
    expect(() => createAgentCliProvider('agent')).toThrow(/agent\/<cli-id>\/<model>/);
  });

  it('rejects unknown CLI ids, listing the known ones', () => {
    expect(() => createAgentCliProvider('agent/nope-cli/model', { command: '/bin/true' })).toThrow(
      /Unknown agent CLI "nope-cli"/,
    );
  });

  it('requires the CLI to be installed (unless command is overridden)', () => {
    expect(() => createAgentCliProvider('agent/claude-code/sonnet')).toThrow(
      /not installed or not on PATH/,
    );
  });

  it('skips the PATH check when a command override is given', () => {
    const p = createAgentCliProvider('agent/codex/gpt-5', { command: '/bin/true' });
    expect(p.providerId).toBe('agent/codex/gpt-5');
  });
});

describe('factory wiring', () => {
  it('createProvider routes agent/ ids to the CLI provider (no API key needed)', () => {
    // PATH check is skipped only via explicit command — here we assert the
    // branch is taken: with a bogus-but-present command it must NOT ask
    // for an API key or a catalog preset.
    registerAgentCliSpec({
      id: 'factory-test-cli',
      command: 'true', // resolvable via PATH — detection passes
      buildArgs: (model, prompt) => [model, prompt],
      notes: 'test',
    });
    const p = createProvider('agent/factory-test-cli/some-model');
    expect(p.providerId).toBe('agent/factory-test-cli/some-model');
  });
});
