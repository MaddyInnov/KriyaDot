// SPDX-License-Identifier: Apache-2.0
// AcpPanel (Teams → ACP agents tab): module-level contract tests.
// Rendering is covered by type-checking; these verify the expected
// exports exist.

import { describe, expect, it } from 'vitest';
import AcpPanel from './acp-panel';

describe('acp-panel', () => {
  it('exports the AcpPanel component', () => {
    expect(typeof AcpPanel).toBe('function');
  });
});
