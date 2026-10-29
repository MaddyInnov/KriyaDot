// SPDX-License-Identifier: Apache-2.0
// WatchPanel (W5 proactive account watching): component rendering is
// covered by type-checking; these tests verify the module loads and the
// expected exports exist.

import { describe, expect, it } from 'vitest';
import { WatchPanel } from './watch-panel';

describe('watch-panel', () => {
  it('exports the WatchPanel component', () => {
    expect(typeof WatchPanel).toBe('function');
  });
});
