// SPDX-License-Identifier: Apache-2.0
// W13: loop-detection health finding (fed by the span store's detector).

import { describe, expect, it } from 'vitest';
import { loopFinding, scoreFromFindings, healthPoints } from '../src/index.js';

describe('loopFinding', () => {
  it('renders a warning finding for a repeated tool call with evidence span ids', () => {
    const f = loopFinding({ kind: 'tool', key: 'web_search', count: 4, spanIds: ['span_1', 'span_2'] });
    expect(f.signal).toBe('loop');
    expect(f.severity).toBe('warning');
    expect(f.title).toContain('web_search');
    expect(f.title).toContain('4');
    expect(f.detail).toContain('span_1');
    expect(f.fix.length).toBeGreaterThan(0);
  });

  it('renders the assistant-text variant', () => {
    const f = loopFinding({ kind: 'text', key: 'assistant-text', count: 3, spanIds: [] });
    expect(f.title).toContain('same assistant text');
  });

  it('a loop finding alone scores needs-work and deducts warning points', () => {
    const f = loopFinding({ kind: 'tool', key: 'echo', count: 3, spanIds: ['a'] });
    expect(scoreFromFindings([f])).toBe('needs-work');
    expect(healthPoints([f])).toBe(85);
  });
});
