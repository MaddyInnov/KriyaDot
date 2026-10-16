// SPDX-License-Identifier: Apache-2.0
// UpdatesPanel exports the component for the Updates settings section.
// Component rendering is covered by type-checking; these tests verify
// the module loads and the expected exports exist.

import { describe, expect, it } from 'vitest';
import { UpdatesPanel } from './updates-panel';

describe('updates-panel', () => {
  it('exports the UpdatesPanel component', () => {
    expect(typeof UpdatesPanel).toBe('function');
  });
});
