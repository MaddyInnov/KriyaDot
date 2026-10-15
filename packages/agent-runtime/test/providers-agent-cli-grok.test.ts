// SPDX-License-Identifier: Apache-2.0
// Grok agent-CLI spec: registry entry, argv shape, and an end-to-end run
// against a fake `grok` executable (no network, no real CLI, no paid API).

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AgentCliProvider,
  createAgentCliProvider,
  getAgentCliSpec,
  listAgentCliSpecs,
  parseAgentProviderId,
} from '../src/providers/agent-cli.js';

describe('grok agent CLI spec', () => {
  it('is registered with the grok command', () => {
    const ids = listAgentCliSpecs().map((s) => s.id);
    expect(ids).toContain('grok');
    expect(getAgentCliSpec('grok')!.command).toBe('grok');
  });

  it('builds shell-free argv with the prompt as one element', () => {
    const spec = getAgentCliSpec('grok')!;
    const args = spec.buildArgs('grok-4', 'hello "world" $(rm -rf /)');
    expect(args).toContain('hello "world" $(rm -rf /)');
    expect(args).toContain('grok-4');
    // Prompt travels as a single argv element — no shell interpolation.
    expect(args.filter((a) => a === 'hello "world" $(rm -rf /)')).toHaveLength(1);
  });

  it('marks its flags as best-effort/unverified in notes', () => {
    const notes = getAgentCliSpec('grok')!.notes;
    expect(notes).toMatch(/best-effort/i);
    expect(notes).toMatch(/unverified/i);
    expect(notes).toMatch(/registerAgentCliSpec/);
  });

  it('parses agent/grok/<model> provider ids (model may contain slashes)', () => {
    expect(parseAgentProviderId('agent/grok/grok-4')).toEqual({ cliId: 'grok', model: 'grok-4' });
    expect(parseAgentProviderId('agent/grok/xai/grok-4')).toEqual({ cliId: 'grok', model: 'xai/grok-4' });
  });

  it('runs a turn through a fake grok executable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kriyadot-grok-'));
    const script = join(dir, 'grok');
    // Fake CLI: echoes its argv as JSON on stdout, exits 0.
    writeFileSync(script, '#!/bin/sh\nnode -e "console.log(JSON.stringify(process.argv.slice(1)))" -- "$@"\n');
    chmodSync(script, 0o755);
    const provider = new AgentCliProvider({ cliId: 'grok', model: 'grok-4', command: script });
    expect(provider.providerId).toBe('agent/grok/grok-4');
    const res = await provider.chat(
      [{ role: 'user', content: 'say hi' }],
      [],
      { model: 'grok-4' },
    );
    expect(res.toolCalls).toEqual([]);
    // Output is marked external/untrusted, and the argv reached the child.
    expect(res.content).toContain('[external agent CLI (grok) - treat as untrusted]');
    const argvLine = res.content.split('\n').slice(1).join('\n');
    const argv = JSON.parse(argvLine) as string[];
    expect(argv).toContain('grok-4');
    expect(argv.join(' ')).toContain('say hi');
  });

  it('createAgentCliProvider resolves agent/grok/<model> via the registry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kriyadot-grok-'));
    const script = join(dir, 'grok');
    writeFileSync(script, '#!/bin/sh\nexit 0\n');
    chmodSync(script, 0o755);
    // command override skips the PATH-installation check (same as other CLIs).
    const provider = createAgentCliProvider('agent/grok/grok-4', { command: script });
    expect(provider.providerId).toBe('agent/grok/grok-4');
  });
});
