// SPDX-License-Identifier: Apache-2.0
// RoutinesPanel now includes the schedule builder (OpenMausBot parity:
// timezone-aware once/daily/cron/interval schedules on routines).
// Component rendering is covered by type-checking; these tests verify
// the module loads and the expected exports exist.

import { describe, expect, it } from 'vitest';
import { RoutinesPanel } from './routines-panel';

describe('routines-panel', () => {
  it('exports the RoutinesPanel component', () => {
    expect(typeof RoutinesPanel).toBe('function');
  });
});
