// SPDX-License-Identifier: Apache-2.0
// Custom stage-prompt overrides: resolution, hot-reload, fallback, safety.

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_STAGE_PROMPTS,
  KNOWN_STAGES,
  PromptOverrideStore,
  logActivePromptOverrides,
  resolvePromptOverridesDir,
} from '../src/prompts.js';

function makeStore(): { store: PromptOverrideStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kriyadot-prompts-'));
  return { store: new PromptOverrideStore({ dir }), dir };
}

describe('resolvePromptOverridesDir', () => {
  it('points at ~/.kriyadot/prompts', () => {
    expect(resolvePromptOverridesDir('/home/testuser')).toBe('/home/testuser/.kriyadot/prompts');
  });
});

describe('PromptOverrideStore.resolve', () => {
  it('falls back to the built-in when no override exists', () => {
    const { store } = makeStore();
    const r = store.resolve('router');
    expect(r.source).toBe('builtin');
    expect(r.text).toBe(BUILT_IN_STAGE_PROMPTS.router);
    expect(r.path).toBeUndefined();
  });

  it('prefers the override file when present', () => {
    const { store, dir } = makeStore();
    writeFileSync(join(dir, 'router.md'), '# My router\nBe decisive.');
    const r = store.resolve('router');
    expect(r.source).toBe('override');
    expect(r.text).toBe('# My router\nBe decisive.');
    expect(r.path).toBe(join(dir, 'router.md'));
  });

  it('hot-reloads without restart when the file changes (mtime check)', () => {
    const { store, dir } = makeStore();
    const path = join(dir, 'summarizer.md');
    writeFileSync(path, 'version one');
    expect(store.resolve('summarizer').text).toBe('version one');
    // Bump mtime deterministically (no sleep needed).
    const later = new Date(Date.now() + 5000);
    writeFileSync(path, 'version two');
    utimesSync(path, later, later);
    expect(store.resolve('summarizer').text).toBe('version two');
  });

  it('falls back to built-in after the override is deleted', () => {
    const { store, dir } = makeStore();
    const path = join(dir, 'router.md');
    writeFileSync(path, 'custom');
    expect(store.resolve('router').source).toBe('override');
    rmSync(path);
    const r = store.resolve('router');
    expect(r.source).toBe('builtin');
    expect(r.text).toBe(BUILT_IN_STAGE_PROMPTS.router);
  });

  it('accepts an explicit builtIn for unknown stages', () => {
    const { store } = makeStore();
    const r = store.resolve('triage', 'triage things');
    expect(r.source).toBe('builtin');
    expect(r.text).toBe('triage things');
  });

  it('throws for unknown stages with no built-in', () => {
    const { store } = makeStore();
    expect(() => store.resolve('nope')).toThrow(/no built-in prompt/);
  });

  it('rejects path-traversal stage names', () => {
    const { store } = makeStore();
    expect(() => store.resolve('../secrets')).toThrow(/Invalid stage name/);
    expect(() => store.resolve('a/b')).toThrow(/Invalid stage name/);
  });

  it('normalizes case', () => {
    const { store, dir } = makeStore();
    writeFileSync(join(dir, 'router.md'), 'custom');
    expect(store.resolve('Router').text).toBe('custom');
  });
});

describe('activeOverrides / logActivePromptOverrides', () => {
  it('lists active overrides sorted by stage', () => {
    const { store, dir } = makeStore();
    writeFileSync(join(dir, 'summarizer.md'), 's');
    writeFileSync(join(dir, 'router.md'), 'r');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    const active = store.activeOverrides();
    expect(active.map((a) => a.stage)).toEqual(['router', 'summarizer']);
  });

  it('logs each active override at boot', () => {
    const { store, dir } = makeStore();
    writeFileSync(join(dir, 'router.md'), 'r');
    const lines: string[] = [];
    logActivePromptOverrides((l) => lines.push(l), store);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('override active: router.md');
    expect(lines[0]).toContain(dir);
  });

  it('logs a clear line when no overrides exist', () => {
    const { store } = makeStore();
    const lines: string[] = [];
    logActivePromptOverrides((l) => lines.push(l), store);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('no overrides');
    expect(lines[0]).toContain('built-in');
  });
});

describe('watch', () => {
  it('is a safe no-op when the dir does not exist', () => {
    const store = new PromptOverrideStore({ dir: join(tmpdir(), 'kriyadot-prompts-missing-xyz') });
    const unwatch = store.watch(() => {
      throw new Error('should not fire');
    });
    expect(() => unwatch()).not.toThrow();
  });

  it('fires onChange when an override file changes', async () => {
    const { store, dir } = makeStore();
    const path = join(dir, 'router.md');
    writeFileSync(path, 'v1');
    store.resolve('router');
    const seen: string[] = [];
    const unwatch = store.watch((stage) => seen.push(stage));
    try {
      const later = new Date(Date.now() + 5000);
      writeFileSync(path, 'v2');
      utimesSync(path, later, later);
      await new Promise((r) => setTimeout(r, 300));
      expect(seen).toContain('router');
      // Cache was invalidated by the watcher: next resolve re-reads.
      expect(store.resolve('router').text).toBe('v2');
    } finally {
      unwatch();
    }
  });
});

describe('built-ins', () => {
  it('ships a prompt for every known stage', () => {
    for (const stage of KNOWN_STAGES) {
      expect(BUILT_IN_STAGE_PROMPTS[stage]).toBeTruthy();
    }
  });
});
