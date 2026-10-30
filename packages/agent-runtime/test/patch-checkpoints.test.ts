// SPDX-License-Identifier: Apache-2.0
// CA-4: extractPatchTargets — the path extraction behind patch checkpointing.

import { describe, expect, it } from 'vitest';
import { extractPatchTargets } from '../src/runtime.js';

describe('extractPatchTargets', () => {
  it('extracts +++ targets, strips a/ b/ prefixes, skips /dev/null', () => {
    const diff = [
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
    ].join('\n');
    expect(extractPatchTargets(diff)).toEqual(['src/new.ts', 'src/gone.ts']);
  });

  it('dedupes repeated files and tolerates junk', () => {
    const diff = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-c\n+d';
    expect(extractPatchTargets(diff)).toEqual(['x.ts']);
    expect(extractPatchTargets('')).toEqual([]);
    expect(extractPatchTargets('not a diff at all')).toEqual([]);
  });
});
