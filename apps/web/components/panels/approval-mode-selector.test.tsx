// SPDX-License-Identifier: Apache-2.0
// ApprovalModeSelector exports the component for the per-bot approval mode
// picker. Component rendering is covered by type-checking; these tests
// verify the module loads and the expected exports exist.

import { describe, expect, it } from 'vitest';
import { ApprovalModeSelector } from './approval-mode-selector';

describe('approval-mode-selector', () => {
  it('exports the ApprovalModeSelector component', () => {
    expect(typeof ApprovalModeSelector).toBe('function');
  });
});
