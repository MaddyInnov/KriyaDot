// SPDX-License-Identifier: Apache-2.0
// Rich tool-history entries (#66): the digest format is a wire
// convention shared with @mvp/governance's history.ts — pinned here
// against a hand-computed SHA-256 of the canonical JSON so the two
// implementations cannot drift silently.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  computeArgDigest,
  makeToolHistoryEntry,
  summarizeArgs,
} from '../src/history-entry.js';

describe('history entries', () => {
  it('canonical JSON sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":1}');
    expect(canonicalJson([{ z: 1, y: 2 }])).toBe('[{"y":2,"z":1}]');
  });

  it('arg digest = sha256 of canonical JSON (governance-compatible)', () => {
    const args = { command: 'git status', verbose: true };
    const canonical = '{"command":"git status","verbose":true}';
    const expected = createHash('sha256').update(canonical, 'utf8').digest('hex');
    expect(computeArgDigest(args)).toBe(expected);
    // Key order in the source object must not matter.
    expect(computeArgDigest({ verbose: true, command: 'git status' })).toBe(expected);
  });

  it('makeToolHistoryEntry carries name, digest and summary', () => {
    const entry = makeToolHistoryEntry('run_command', { command: 'git status' });
    expect(entry.name).toBe('run_command');
    expect(entry.argDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.argSummary).toBe('command=git status');
    expect(makeToolHistoryEntry('read_file')).toEqual({ name: 'read_file' });
  });

  it('summarizeArgs sorts keys and truncates', () => {
    expect(summarizeArgs({ b: '2', a: '1' })).toBe('a=1 b=2');
    const long = summarizeArgs({ k: 'x'.repeat(500) });
    expect(long.length).toBeLessThanOrEqual(500);
    expect(long.startsWith('k=' + 'x'.repeat(198))).toBe(true);
  });
});
