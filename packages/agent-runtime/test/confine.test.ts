// SPDX-License-Identifier: Apache-2.0
// Tests for symlink-aware workspace confinement (M3). Uses real symlinks in
// temp dirs — no network, no paid APIs.

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { confineRealpath } from '../src/confine.js';
import { createBuiltInTools } from '../src/tools/builtin.js';
import { __test__ as codingTest, createCodingTools } from '../src/tools/coding.js';
import type { ToolContext } from '../src/types.js';

const CTX: ToolContext = { sessionId: 's', botId: 'b' };
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeWs(): string {
  const d = mkdtempSync(join(tmpdir(), 'confine-ws-'));
  dirs.push(d);
  return d;
}

async function makeOutside(): Promise<{ dir: string; secret: string }> {
  const d = mkdtempSync(join(tmpdir(), 'confine-out-'));
  dirs.push(d);
  const secret = join(d, 'secret.txt');
  await writeFile(secret, 'top secret', 'utf8');
  return { dir: d, secret };
}

describe('confineRealpath', () => {
  it('resolves normal paths inside the workspace', () => {
    const ws = makeWs();
    expect(confineRealpath(ws, 'a/b.txt')).toBe(join(ws, 'a', 'b.txt'));
    expect(confineRealpath(ws, '.')).toBe(ws);
  });

  it('rejects lexical traversal', () => {
    const ws = makeWs();
    expect(() => confineRealpath(ws, '../evil.txt')).toThrow(/escapes workspace/);
    expect(() => confineRealpath(ws, 'sub/../../evil.txt')).toThrow(/escapes workspace/);
  });

  it('rejects symlinks pointing outside the workspace', async () => {
    const ws = makeWs();
    const { dir: outside } = await makeOutside();
    await symlink(outside, join(ws, 'evil-link'));
    expect(() => confineRealpath(ws, 'evil-link/secret.txt')).toThrow(/escapes workspace/);
    // Symlink to a single outside file.
    await symlink(join(outside, 'secret.txt'), join(ws, 'evil-file'));
    expect(() => confineRealpath(ws, 'evil-file')).toThrow(/escapes workspace/);
  });

  it('allows symlinks that stay inside the workspace', async () => {
    const ws = makeWs();
    await mkdir(join(ws, 'sub'), { recursive: true });
    await writeFile(join(ws, 'sub', 'real.txt'), 'inside', 'utf8');
    await symlink(join(ws, 'sub'), join(ws, 'ok-link'));
    expect(confineRealpath(ws, 'ok-link/real.txt')).toBe(join(ws, 'sub', 'real.txt'));
  });

  it('works for paths that do not exist yet', () => {
    const ws = makeWs();
    expect(confineRealpath(ws, 'newdir/newfile.txt')).toBe(join(ws, 'newdir', 'newfile.txt'));
  });
});

describe('built-in tools enforce symlink confinement (M3)', () => {
  it('read_file and write_file reject symlink escapes', async () => {
    const ws = makeWs();
    const { dir: outside } = await makeOutside();
    await symlink(outside, join(ws, 'evil-link'));
    const tools = createBuiltInTools({ workspaceDir: ws });
    const byName = new Map(tools.map((t) => [t.name, t]));
    await expect(byName.get('read_file')!.handler({ path: 'evil-link/secret.txt' }, CTX)).rejects.toThrow(
      /escapes workspace/,
    );
    await expect(
      byName.get('write_file')!.handler({ path: 'evil-link/pwned.txt', content: 'x' }, CTX),
    ).rejects.toThrow(/escapes workspace/);
    // …but a normal write+read round-trips fine.
    await byName.get('write_file')!.handler({ path: 'notes.txt', content: 'hi' }, CTX);
    expect(await byName.get('read_file')!.handler({ path: 'notes.txt' }, CTX)).toBe('hi');
  });
});

describe('coding tools enforce symlink confinement (M3)', () => {
  it('__test__.confine rejects symlink escapes, allows inside symlinks', async () => {
    const ws = makeWs();
    const { dir: outside } = await makeOutside();
    await symlink(outside, join(ws, 'evil-link'));
    expect(() => codingTest.confine(ws, 'evil-link/secret.txt')).toThrow(/escapes workspace/);
    await mkdir(join(ws, 'sub'), { recursive: true });
    await symlink(join(ws, 'sub'), join(ws, 'ok-link'));
    expect(codingTest.confine(ws, 'ok-link/x.txt')).toBe(join(ws, 'sub', 'x.txt'));
  });

  it('edit rejects symlink escapes', async () => {
    const ws = makeWs();
    const { dir: outside } = await makeOutside();
    await symlink(outside, join(ws, 'evil-link'));
    const tools = createCodingTools({ workspaceDir: ws });
    const edit = new Map(tools.map((t) => [t.name, t])).get('edit')!;
    await expect(
      edit.handler({ path: 'evil-link/secret.txt', oldText: 'top', newText: 'x' }, CTX),
    ).rejects.toThrow(/escapes workspace/);
  });
});
