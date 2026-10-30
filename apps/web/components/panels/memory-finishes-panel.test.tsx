// SPDX-License-Identifier: Apache-2.0
// MemoryFinishesPanel (MEM-4/5/6/7/9): module-level contract test,
// matching the memory-panel test pattern.

import { describe, expect, it } from 'vitest';
import { MemoryFinishesPanel } from './memory-finishes-panel';

describe('memory-finishes-panel', () => {
  it('exports the MemoryFinishesPanel component', () => {
    expect(typeof MemoryFinishesPanel).toBe('function');
  });
});
