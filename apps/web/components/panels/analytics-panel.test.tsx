// SPDX-License-Identifier: Apache-2.0
// AnalyticsPanel exports the component for the Privacy & analytics section.
// Component rendering is covered by type-checking; these tests verify
// the module loads and the expected exports exist.

import { describe, expect, it } from 'vitest';
import { AnalyticsPanel } from './analytics-panel';

describe('analytics-panel', () => {
  it('exports the AnalyticsPanel component', () => {
    expect(typeof AnalyticsPanel).toBe('function');
  });
});
