// SPDX-License-Identifier: Apache-2.0
/**
 * Regression tests for the v0.2.0-alpha compiled-sidecar boot crash:
 * loadSubagentProfiles() threw "subagent-profiles.json not found" inside
 * the Bun-compiled binary (import.meta.url points into the virtual bundle
 * filesystem, where the on-disk candidates do not exist), and the throw —
 * raised from the SubagentProfileRegistry constructor default argument —
 * killed API boot. The loader must (a) fall back to the bundled JSON copy,
 * and (b) fail soft (empty library + warning) when every source misses.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  loadSubagentProfiles,
  resolveSubagentProfiles,
  SubagentProfileRegistry,
} from '../src/subagent-profiles.js';
import bundledProfilesJson from '../src/profiles-data/subagent-profiles.json' with { type: 'json' };

const MISSING = ['/nonexistent-dir/subagent-profiles.json', '/also/missing/subagent-profiles.json'];

describe('subagent profile loader — compiled-binary regression', () => {
  it('loads the full shipped library (155 profiles) from a normal layout', () => {
    const profiles = loadSubagentProfiles();
    expect(profiles.length).toBe(155);
    expect(profiles.length).toBe((bundledProfilesJson as unknown[]).length);
    const registry = new SubagentProfileRegistry();
    expect(registry.size).toBe(155);
    expect(registry.get('engineering-api-designer')?.name).toBeTruthy();
  });

  it('returns the bundled copy when every filesystem candidate is absent (compiled layout)', () => {
    const fixture = [
      { id: 'bundled-one', name: 'Bundled One', specialty: 'x', description: '', systemPrompt: 'You are one.', suggestedTools: [] },
      { id: 'bundled-two', name: 'Bundled Two', specialty: 'y', description: '', systemPrompt: 'You are two.', suggestedTools: ['read'] },
    ];
    const out = resolveSubagentProfiles(MISSING, fixture);
    expect(out.map((p) => p.id)).toEqual(['bundled-one', 'bundled-two']);
    expect(new SubagentProfileRegistry(out).size).toBe(2);
  });

  it('fails soft — empty library, warning, no throw — when the file is missing everywhere', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let out: ReturnType<typeof resolveSubagentProfiles> | undefined;
      expect(() => { out = resolveSubagentProfiles(MISSING, null); }).not.toThrow();
      expect(out).toEqual([]);
      expect(warn).toHaveBeenCalled();
      // The registry must never take down boot over this file.
      expect(() => new SubagentProfileRegistry(out)).not.toThrow();
      expect(new SubagentProfileRegistry(out).size).toBe(0);
      // An unusable bundled copy (wrong shape) fails soft the same way.
      expect(resolveSubagentProfiles(MISSING, { not: 'an array' })).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('filesystem candidate still wins over the bundled copy (dev-machine edits)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-profiles-'));
    const file = join(dir, 'subagent-profiles.json');
    writeFileSync(file, JSON.stringify([
      { id: 'from-disk', name: 'From Disk', specialty: '', description: '', systemPrompt: 'Disk copy.', suggestedTools: [] },
    ]));
    const bundled = [
      { id: 'from-bundle', name: 'From Bundle', specialty: '', description: '', systemPrompt: 'Bundle copy.', suggestedTools: [] },
    ];
    const out = resolveSubagentProfiles([file], bundled);
    expect(out.map((p) => p.id)).toEqual(['from-disk']);
  });
});
