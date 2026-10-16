// SPDX-License-Identifier: Apache-2.0
// GoalsPanel (Teams → Group goals tab): module-level contract tests.
// Rendering is covered by type-checking; these verify the expected
// exports exist.

import { describe, expect, it } from 'vitest';
import GoalsPanel from './goals-panel';

describe('goals-panel', () => {
  it('exports the GoalsPanel component', () => {
    expect(typeof GoalsPanel).toBe('function');
  });
});
