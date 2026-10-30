// SPDX-License-Identifier: Apache-2.0
// GoalFinishesPanel (Goals view → G-2/G-3/G-5/G-6/G-7/G-8/G-10):
// module-level contract test, matching the goals-panel test pattern.

import { describe, expect, it } from 'vitest';
import GoalFinishesPanel from './goal-finishes-panel';

describe('goal-finishes-panel', () => {
  it('exports the GoalFinishesPanel component', () => {
    expect(typeof GoalFinishesPanel).toBe('function');
  });
});
