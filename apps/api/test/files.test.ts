// SPDX-License-Identifier: Apache-2.0
// Tests for symlink-aware file confinement in the file browser API (M3).
// Fully offline — real symlinks in temp dirs.

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { confineFile, readWorkspaceFile } from '../src/files.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeWs(): string {
  const d = mkdtempSync(join(tmpdir(), 'files-ws-'));
  dirs.push(d);
  return d;
}

describe('confineFile (M3: symlink escape)', () => {
  it('rejects lexical traversal', () => {
    const ws = makeWs();
    expect(() => confineFile(ws, '../evil.txt')).toThrow(/escapes workspace/);
  });

  it('rejects symlink escapes on read', async () => {
    const ws = makeWs();
    const outside = mkdtempSync(join(tmpdir(), 'files-out-'));
    dirs.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'top secret', 'utf8');
    await symlink(outside, join(ws, 'evil-link'));
    expect(() => confineFile(ws, 'evil-link/secret.txt')).toThrow(/escapes workspace/);
    expect(() => readWorkspaceFile(ws, 'evil-link/secret.txt')).toThrow(/escapes workspace/);
  });

  it('allows symlinks that stay inside the workspace', async () => {
    const ws = makeWs();
    await mkdir(join(ws, 'sub'), { recursive: true });
    await writeFile(join(ws, 'sub', 'real.txt'), 'inside', 'utf8');
    await symlink(join(ws, 'sub'), join(ws, 'ok-link'));
    expect(confineFile(ws, 'ok-link/real.txt')).toBe(join(ws, 'sub', 'real.txt'));
    expect(readWorkspaceFile(ws, 'ok-link/real.txt').content).toBe('inside');
  });

  it('reads normal files', async () => {
    const ws = makeWs();
    await writeFile(join(ws, 'notes.txt'), 'hello', 'utf8');
    expect(readWorkspaceFile(ws, 'notes.txt').content).toBe('hello');
  });
});
