// SPDX-License-Identifier: Apache-2.0

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBuiltInTools, isCatastrophicCommand } from '../src/tools/builtin.js';
import type { ToolContext, ToolDefinition } from '../src/types.js';

const CTX: ToolContext = { sessionId: 's', botId: 'b' };

async function makeTools(): Promise<{ dir: string; byName: Map<string, ToolDefinition> }> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-tools-'));
  const tools = createBuiltInTools({ workspaceDir: dir });
  return { dir, byName: new Map(tools.map((t) => [t.name, t])) };
}

describe('built-in tools', () => {
  it('exposes the five expected tools with JSON Schema parameters', async () => {
    const { byName } = await makeTools();
    for (const name of ['read_file', 'write_file', 'run_command', 'web_search', 'web_fetch']) {
      const tool = byName.get(name);
      expect(tool).toBeDefined();
      expect(tool?.parameters).toMatchObject({ type: 'object', properties: expect.anything() });
    }
  });

  it('blocks write_file directory traversal outside the workspace', async () => {
    const { byName } = await makeTools();
    const write = byName.get('write_file')!;
    await expect(write.handler({ path: '../evil.txt', content: 'x' }, CTX)).rejects.toThrow(
      /escapes workspace/,
    );
    await expect(write.handler({ path: 'sub/../../evil.txt', content: 'x' }, CTX)).rejects.toThrow(
      /escapes workspace/,
    );
  });

  it('blocks read_file directory traversal outside the workspace', async () => {
    const { byName } = await makeTools();
    const read = byName.get('read_file')!;
    await expect(read.handler({ path: '../package.json' }, CTX)).rejects.toThrow(/escapes workspace/);
  });

  it('round-trips write_file then read_file inside the workspace', async () => {
    const { byName } = await makeTools();
    const write = byName.get('write_file')!;
    const read = byName.get('read_file')!;
    await write.handler({ path: 'sub/notes.txt', content: 'hello workspace' }, CTX);
    expect(await read.handler({ path: 'sub/notes.txt' }, CTX)).toBe('hello workspace');
  });

  it('refuses denylisted shell patterns', async () => {
    const { byName } = await makeTools();
    const run = byName.get('run_command')!;
    await expect(run.handler({ command: 'rm -rf / tmp' }, CTX)).rejects.toThrow(/denylist/);
    await expect(run.handler({ command: 'mkfs.ext4 /dev/sda' }, CTX)).rejects.toThrow(/denylist/);
    await expect(run.handler({ command: 'dd of=/dev/sda if=/dev/zero' }, CTX)).rejects.toThrow(
      /denylist/,
    );
    await expect(run.handler({ command: ':(){ :|:& };:' }, CTX)).rejects.toThrow(/denylist/);
  });

  // 60s, not the 5s default: on machines with Docker this goes through a
  // real `docker run` (cold image pull + container start included), which
  // is environment latency, not test work — 5s made CI flake on slow pulls.
  it('runs benign commands and captures output', async () => {
    const { byName } = await makeTools();
    const run = byName.get('run_command')!;
    const ok = (await run.handler({ command: 'echo hi' }, CTX)) as {
      exitCode: number;
      stdout: string;
    };
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.trim()).toBe('hi');
    const failing = (await run.handler({ command: 'exit 3' }, CTX)) as { exitCode: number };
    expect(failing.exitCode).toBe(3);
  }, 60_000);
});

describe('isCatastrophicCommand (M1: rm flag-variant bypass)', () => {
  it('flags rm -rf / and the classic variants', () => {
    for (const cmd of ['rm -rf /', 'rm -r -f /', 'rm -f -r /', 'rm -r /', 'rm -R /', 'sudo rm -rf /']) {
      expect(isCatastrophicCommand(cmd)).toBe(true);
    }
  });

  it('flags the M1 bypass variants', () => {
    for (const cmd of [
      'rm -rfv /etc',
      'rm -rf --one-file-system /',
      'rm -rfv --preserve-root=no /',
      'rm --recursive --force /',
      'rm -rfi /tmp/cache',
    ]) {
      expect(isCatastrophicCommand(cmd)).toBe(true);
    }
  });

  it('does not flag benign commands', () => {
    for (const cmd of [
      'echo hello',
      'rm -rf ./build',
      'rm -rf workspace/out.txt',
      'rm -f /tmp/stale.lock',
      'rm -- -rf /',
      'ls /etc',
    ]) {
      expect(isCatastrophicCommand(cmd)).toBe(false);
    }
  });

  it('run_command refuses the bypass variants', async () => {
    const { byName } = await makeTools();
    const run = byName.get('run_command')!;
    await expect(run.handler({ command: 'rm -rfv /etc' }, CTX)).rejects.toThrow(/denylist/);
    await expect(run.handler({ command: 'rm -rf --one-file-system /' }, CTX)).rejects.toThrow(
      /denylist/,
    );
  });
});
