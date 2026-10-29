// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearProjectInstructionsCache,
  loadProjectInstructions,
} from '../src/project-instructions.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mvp-proj-instr-'));
  clearProjectInstructionsCache();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearProjectInstructionsCache();
});

describe('loadProjectInstructions', () => {
  it('returns undefined when no instruction files exist', () => {
    expect(loadProjectInstructions(dir)).toBeUndefined();
  });

  it('loads AGENTS.md with provenance', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'Always run the tests before committing.');
    const loaded = loadProjectInstructions(dir);
    expect(loaded?.files).toEqual(['AGENTS.md']);
    expect(loaded?.text).toContain('## Project instructions — AGENTS.md');
    expect(loaded?.text).toContain('Always run the tests before committing.');
  });

  it('combines all candidate files in order', () => {
    writeFileSync(join(dir, 'KRIYADOT.md'), 'Kriya rules.');
    writeFileSync(join(dir, 'AGENTS.md'), 'Agent rules.');
    const loaded = loadProjectInstructions(dir)!;
    expect(loaded.files).toEqual(['AGENTS.md', 'KRIYADOT.md']);
    expect(loaded.text.indexOf('Agent rules.')).toBeLessThan(loaded.text.indexOf('Kriya rules.'));
  });

  it('loads .kriyadot/instructions.md', () => {
    mkdirSync(join(dir, '.kriyadot'));
    writeFileSync(join(dir, '.kriyadot', 'instructions.md'), 'Nested rules.');
    const loaded = loadProjectInstructions(dir);
    expect(loaded?.files).toEqual(['.kriyadot/instructions.md']);
    expect(loaded?.text).toContain('Nested rules.');
  });

  it('reflects edits (mtime/size cache invalidation)', () => {
    const path = join(dir, 'AGENTS.md');
    writeFileSync(path, 'Version one of the rules.');
    expect(loadProjectInstructions(dir)?.text).toContain('Version one');
    writeFileSync(path, 'Version two of the rules, longer.');
    expect(loadProjectInstructions(dir)?.text).toContain('Version two');
  });

  it('caps oversized files', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'x'.repeat(50_000));
    const loaded = loadProjectInstructions(dir)!;
    expect(loaded.text.length).toBeLessThan(17_000);
    expect(loaded.text).toContain('truncated');
  });

  it('ignores empty files', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '   \n  ');
    expect(loadProjectInstructions(dir)).toBeUndefined();
  });
});
